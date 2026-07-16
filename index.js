const express = require('express');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const ollama = require('ollama').default;
const pool = require('./db');
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

// Chunking Fonksiyonu
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
// ADIM 1: PDF YÜKLEME VE İŞLEME ENDPOINT'İ
// ==========================================
app.post('/upload', upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: "Lütfen bir dosya yükleyin." });
    }

    const client = await pool.connect();

    try {
        const pdfData = await pdfParse(req.file.buffer);
        const fullText = pdfData.text;

        if (!fullText || fullText.trim().length === 0) {
            return res.status(400).json({ error: "Yüklenen PDF'ten metin okunamadı." });
        }

        // Transaction başlat - ya hepsi başarılı olur ya da hiçbiri kaydedilmez
        await client.query('BEGIN');

        const docResult = await client.query(
            'INSERT INTO documents (filename) VALUES ($1) RETURNING id',
            [req.file.originalname]
        );
        const documentId = docResult.rows[0].id;

        const rawChunks = chunkText(fullText, 500, 50);
        const BATCH_SIZE = 5;

        for (let i = 0; i < rawChunks.length; i += BATCH_SIZE) {
            const batch = rawChunks.slice(i, i + BATCH_SIZE);

            const batchPromises = batch.map(async (chunkContent, idx) => {
                const embeddingResponse = await ollama.embeddings({
                    model: 'nomic-embed-text',
                    prompt: chunkContent
                });
                return { content: chunkContent, embedding: embeddingResponse.embedding, index: i + idx };
            });

            const batchResults = await Promise.all(batchPromises);

            for (const item of batchResults) {
                // pgvector, embedding'i '[0.1,0.2,...]' formatında string bekler
                const vectorString = `[${item.embedding.join(',')}]`;
                await client.query(
                    'INSERT INTO chunks (document_id, content, embedding, chunk_index) VALUES ($1, $2, $3, $4)',
                    [documentId, item.content, vectorString, item.index]
                );
            }
        }

        await client.query('COMMIT');

        res.json({
            message: "PDF başarıyla yüklendi ve veritabanına kaydedildi!",
            documentId,
            totalChunks: rawChunks.length
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error("PDF işleme hatası:", error);
        res.status(500).json({ error: "PDF işlenirken hata oluştu.", details: error.message });
    } finally {
        client.release();
    }
});

// ==========================================
// ADIM 2: SORU SORMA ENDPOINT'İ (GÜVENLİ HALE GETİRİLMİŞ)
// ==========================================
app.post('/ask', async (req, res) => {
    const { question } = req.body;

    if (!question) {
        return res.status(400).json({ error: "Lütfen 'question' parametresini gönderin." });
    }

    try {
        const questionEmbeddingResponse = await ollama.embeddings({
            model: 'nomic-embed-text',
            prompt: question
        });
        const questionVector = `[${questionEmbeddingResponse.embedding.join(',')}]`;

        const searchResult = await pool.query(
            `SELECT 
                content, 
                1 - (embedding <=> $1) AS similarity
             FROM chunks
             ORDER BY embedding <=> $1
             LIMIT 5`,
            [questionVector]
        );

        const topChunks = searchResult.rows;

        if (topChunks.length === 0) {
            return res.status(400).json({ error: "Veritabanında hiç chunk yok, önce bir doküman yükleyin." });
        }

        const bestScore = topChunks[0].similarity;
        let contextText;

        if (bestScore < 0.30) {
            contextText = "Bu soruyla ilgili yüklenen dökümanda hiçbir bilgi bulunmamaktadır.";
        } else {
            contextText = topChunks
                .map((c, i) => `[Kaynak ${i + 1}]: ${c.content}`)
                .join('\n\n');
        }

        const systemPrompt = `Sen yardımcı bir yapay zeka asistanısın. Sadece sana verilen aşağıdaki kaynaklara sadık kalarak soruyu cevapla. Kaynaklar arasında birbiriyle alakasız olanlar olabilir, sadece soruyla ilgili olanı kullan. Eğer hiçbir kaynak sorunun cevabını içermiyorsa, kibarca 'Bu bilgi dökümanda yer almıyor' de.

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
        res.status(500).json({ error: "Soru cevaplanırken hata oluştu.", details: error.message });
    }
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`RAG Sunucusu http://localhost:${PORT} adresinde aktif!`);
});