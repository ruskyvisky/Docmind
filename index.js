const express = require('express');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const ollama = require('ollama').default;

const app = express();
app.use(express.json());

// Bellek tabanlı dosya yükleme ayarı
const upload = multer({ storage: multer.memoryStorage() });

// Dinamik bellek havuzumuz
let globalChunks = [];

// Kosinüs Benzerliği Fonksiyonu
function cosineSimilarity(vecA, vecB) {
    let dotProduct = 0.0;
    let normA = 0.0;
    let normB = 0.0;
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Güçlendirilmiş Chunking Fonksiyonu
function chunkText(text, chunkSize = 500, overlap = 50) {
    const cleanText = text.replace(/\r\n/g, '\n').trim();

    // Önce "Bölüm X:" gibi başlıklara göre böl
    const sections = cleanText.split(/(?=Bölüm \d+:)/g).filter(s => s.trim().length > 0);

    const chunks = [];
    for (const section of sections) {
        const clean = section.replace(/\s+/g, ' ').trim();
        let i = 0;
        while (i < clean.length) {
            const chunk = clean.substring(i, i + chunkSize);
            chunks.push(chunk);
            i += (chunkSize - overlap);
        }
    }
    return chunks;
}

// ==========================================
// ADIM 1: PDF YÜKLEME VE İŞLEME ENDPOINT'İ (HIZLANDIRILMIŞ)
// ==========================================
app.post('/upload', upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: "Lütfen bir dosya yükleyin." });
    }

    try {
        console.log(`Dosya alındı: ${req.file.originalname}`);

        // A. PDF'ten metni ayıkla
        const pdfData = await pdfParse(req.file.buffer);
        const fullText = pdfData.text;

        if (!fullText || fullText.trim().length === 0) {
            return res.status(400).json({ error: "Yüklenen PDF'ten metin okunamadı veya PDF boş." });
        }

        // B. Metni parçala
        const rawChunks = chunkText(fullText, 500, 50);
        console.log(`Metin ${rawChunks.length} adet parçaya (chunk) bölündü.`);

        // C. BATCH (TOPLU) EMBEDDING:
        // Tüm chunk'ları aynı anda göndermek Ollama'yı bunaltır ("maximum pending requests exceeded").
        // Bunun yerine chunk'ları küçük gruplar (batch) halinde işliyoruz.
        // Her batch tamamlanmadan bir sonrakine geçmiyoruz.
        const BATCH_SIZE = 5; // Aynı anda en fazla 5 istek gönder
        const allResults = [];

        console.log(`Embedding işlemleri ${BATCH_SIZE}'li gruplar halinde başlatılıyor...`);

        for (let i = 0; i < rawChunks.length; i += BATCH_SIZE) {
            // Mevcut batch'i al (son batch, BATCH_SIZE'dan küçük olabilir)
            const batch = rawChunks.slice(i, i + BATCH_SIZE);
            const batchIndex = Math.floor(i / BATCH_SIZE) + 1;
            const totalBatches = Math.ceil(rawChunks.length / BATCH_SIZE);
            console.log(`Batch ${batchIndex}/${totalBatches} işleniyor (${batch.length} chunk)...`);

            // Bu batch'teki chunk'ları paralel gönder, batch bitmeden devam etme
            const batchPromises = batch.map(async (chunkTextContent) => {
                try {
                    const embeddingResponse = await ollama.embeddings({
                        model: 'nomic-embed-text',
                        prompt: chunkTextContent
                    });
                    return {
                        text: chunkTextContent,
                        embedding: embeddingResponse.embedding
                    };
                } catch (err) {
                    console.error("Bir chunk embed edilirken hata oluştu, atlanıyor...", err.message);
                    return null;
                }
            });

            // Bu batch'in tamamlanmasını bekle, sonra döngü bir sonraki batch'e geçer
            const batchResults = await Promise.all(batchPromises);
            allResults.push(...batchResults);
        }

        // Hatalı veya boş dönen chunk'ları filtrele
        globalChunks = allResults.filter(item => item !== null);

        console.log(`Hafıza güncellendi. Toplam aktif chunk: ${globalChunks.length}`);

        res.json({
            message: "PDF başarıyla yüklendi, parçalandı ve paralel olarak embed edildi!",
            totalChunks: globalChunks.length
        });

    } catch (error) {
        console.error("PDF işleme hatası:", error);
        res.status(500).json({ error: "PDF işlenirken bir hata oluştu.", details: error.message });
    }
});

// ==========================================
// ADIM 2: SORU SORMA ENDPOINT'İ (GÜVENLİ HALE GETİRİLMİŞ)
// ==========================================
app.post('/ask', async (req, res) => {
    const { question } = req.body;

    if (globalChunks.length === 0) {
        return res.status(400).json({ error: "Lütfen önce /upload endpoint'ini kullanarak bir PDF yükleyin." });
    }
    if (!question) {
        return res.status(400).json({ error: "Lütfen 'question' parametresini gönderin." });
    }

    try {
        const questionEmbeddingResponse = await ollama.embeddings({
            model: 'nomic-embed-text',
            prompt: question
        });
        const questionEmbedding = questionEmbeddingResponse.embedding;

        const scoredChunks = globalChunks.map(chunk => ({
            text: chunk.text,
            similarity: cosineSimilarity(questionEmbedding, chunk.embedding)
        }));

        scoredChunks.sort((a, b) => b.similarity - a.similarity);

        // TOP-K: sadece 1 değil, en yakın 4 chunk'ı al
        const TOP_K = 4;
        const topChunks = scoredChunks.slice(0, TOP_K);

        console.log("Getirilen chunk skorları:", topChunks.map(c => c.similarity.toFixed(3)));

        // Eşik kontrolünü artık EN İYİ skora göre yapıyoruz (top-1'e göre değil)
        const bestScore = topChunks[0].similarity;
        let contextText;

        if (bestScore < 0.30) {
            contextText = "Bu soruyla ilgili yüklenen dökümanda hiçbir bilgi bulunmamaktadır.";
        } else {
            // Birden fazla chunk'ı numaralandırarak birleştir
            contextText = topChunks
                .map((c, i) => `[Kaynak ${i + 1}]: ${c.text}`)
                .join('\n\n');
        }

        const systemPrompt = `Sen yardımcı bir yapay zeka asistanısın. Sadece sana verilen aşağıdaki kaynaklara sadık kalarak soruyu cevapla. Kaynaklar arasında birbiriyle alakasız olanlar olabilir, sadece soruyla ilgili olanı kullan. Eğer hiçbir kaynak sorunun cevabını içermiyorsa, kendi bilgini kullanma ve kibarca 'Bu bilgi dökümanda yer almıyor' de.

${contextText}`;

        const chatResponse = await ollama.chat({
            model: 'llama3.1:8b',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: question }
            ]
        });

        res.json({
            question,
            retrievedChunks: topChunks,
            answer: chatResponse.message.content
        });

    } catch (error) {
        console.error("Soru cevaplama hatası:", error);
        res.status(500).json({ error: "Soru cevaplanırken bir hata oluştu.", details: error.message });
    }
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`RAG Sunucusu http://localhost:${PORT} adresinde aktif!`);
});