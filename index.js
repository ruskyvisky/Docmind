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
    const chunks = [];
    let i = 0;

    // Metindeki gereksiz boşlukları temizle
    const cleanText = text.replace(/\s+/g, ' ').trim();

    while (i < cleanText.length) {
        let chunk = cleanText.substring(i, i + chunkSize);
        chunks.push(chunk);
        i += (chunkSize - overlap);
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
        console.log(`Soru alındı: "${question}"`);

        // A. Sorunun vektörünü al
        const questionEmbeddingResponse = await ollama.embeddings({
            model: 'nomic-embed-text',
            prompt: question
        });
        const questionEmbedding = questionEmbeddingResponse.embedding;

        // B. Benzerlik skorlarını hesapla
        const scoredChunks = globalChunks.map(chunk => {
            const similarity = cosineSimilarity(questionEmbedding, chunk.embedding);
            return { text: chunk.text, similarity };
        });

        // C. En yakından en uzağa sırala
        scoredChunks.sort((a, b) => b.similarity - a.similarity);
        const bestMatch = scoredChunks[0];

        console.log(`En yakın chunk skor: ${bestMatch.similarity.toFixed(4)}`);

        // GÜVENLİK BARAJI (THRESHOLD): 
        // Eğer en yakın dökümanın benzerliği %30'un (0.30) altındaysa, yapay zekaya alakasız bilgi vermeyelim.
        let contextText = bestMatch.text;
        if (bestMatch.similarity < 0.30) {
            console.warn("Eşleşme skoru çok düşük, boş context gönderiliyor.");
            contextText = "Bu soruyla ilgili yüklenen dökümanda hiçbir bilgi bulunmamaktadır.";
        }

        // D. Llama modeline gönder
        const systemPrompt = `Sen yardımcı bir yapay zeka asistanısın. Sadece sana verilen aşağıdaki bağlama (Context) sadık kalarak soruyu cevapla. Eğer bağlam içinde sorunun cevabı yoksa, kendi bilgini kullanma ve kibarca 'Bu bilgi dökümanda yer almıyor' de.
Bağlam: "${contextText}"`;

        const chatResponse = await ollama.chat({
            model: 'llama3.1:8b',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: question }
            ]
        });

        res.json({
            question,
            retrievedContext: contextText,
            similarityScore: bestMatch.similarity,
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