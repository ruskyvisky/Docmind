const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { Queue } = require('bullmq');
const pool = require('./db');
const redisClient = require('./redis');
const connection = require('./bullmq-connection');
const {
    getCachedEmbedding,
    setCachedEmbedding,
    ollamaEmbed,
    ollamaChat,
    OLLAMA_HOST
} = require('./utils');

// Worker'ı aynı süreçte başlat
require('./worker');

const app = express();
app.use(express.json());

// ==========================================
// MULTER — DISK STORAGE
// ==========================================
const UPLOADS_DIR = path.join(__dirname, 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    console.log('[Multer] uploads/ klasörü oluşturuldu.');
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        const uniqueName = `${Date.now()}-${uuidv4()}${ext}`;
        cb(null, uniqueName);
    },
});

const upload = multer({
    storage,
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/pdf') {
            cb(null, true);
        } else {
            cb(new Error('Yalnızca PDF dosyaları kabul edilmektedir.'));
        }
    },
});

// ==========================================
// BULLMQ QUEUE
// ==========================================
const ingestionQueue = new Queue('ingestion-queue', { connection });

// ==========================================
// UPLOAD ENDPOINT
// ==========================================
app.post('/upload', upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Lütfen bir PDF dosyası yükleyin.' });
    }

    try {
        const filePath = req.file.path;
        const originalName = req.file.originalname;

        const docResult = await pool.query(
            'INSERT INTO documents (filename, status) VALUES ($1, $2) RETURNING id',
            [originalName, 'processing']
        );
        const documentId = docResult.rows[0].id;

        await ingestionQueue.add(
            'process-pdf',
            { documentId, filePath, originalName },
            {
                attempts: 3,
                backoff: { type: 'exponential', delay: 5000 },
                removeOnComplete: 100,
                removeOnFail: 50,
            }
        );

        console.log(`[Upload] "${originalName}" kuyruğa eklendi → documentId=${documentId}`);

        return res.status(202).json({
            message: 'Dosya yükleme işlemi arka planda başlatıldı.',
            documentId,
            status: 'processing',
        });

    } catch (error) {
        console.error('[Upload] Hata:', error);
        return res.status(500).json({ error: 'Dosya yükleme sırasında hata oluştu.', details: error.message });
    }
});

// ==========================================
// STATUS ENDPOINT
// ==========================================
app.get('/documents/:id/status', async (req, res) => {
    const { id } = req.params;
    if (isNaN(parseInt(id, 10))) {
        return res.status(400).json({ error: 'Geçersiz doküman ID.' });
    }

    try {
        const result = await pool.query(
            'SELECT id, filename, status, uploaded_at FROM documents WHERE id = $1',
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: `ID=${id} olan doküman bulunamadı.` });
        }

        const doc = result.rows[0];
        return res.json({
            documentId: doc.id,
            filename: doc.filename,
            status: doc.status,
            uploadedAt: doc.uploaded_at,
        });

    } catch (error) {
        console.error('[Status] Hata:', error);
        return res.status(500).json({ error: 'Durum sorgulanırken hata oluştu.', details: error.message });
    }
});

// ==========================================
// ASK ENDPOINT (Hybrid Search)
// ==========================================
app.post('/ask', async (req, res) => {
    const { question } = req.body;
    if (!question) {
        return res.status(400).json({ error: "Lütfen 'question' parametresini gönderin." });
    }

    try {
        // 1. Get question embedding from cache or Ollama
        let questionEmbedding = await getCachedEmbedding(question);
        let questionCacheHit = false;

        if (questionEmbedding) {
            questionCacheHit = true;
            console.log("[Ask] Soru embedding'i Redis cache'ten alındı ✓");
        } else {
            const response = await ollamaEmbed(question);
            questionEmbedding = response.embedding;
            await setCachedEmbedding(question, questionEmbedding);
            console.log("[Ask] Soru embedding'i Ollama'dan alındı ve önbelleğe kaydedildi.");
        }

        const questionVector = `[${questionEmbedding.join(',')}]`;

        // 2. Hybrid Search: Vector + Full-Text
        const searchResult = await pool.query(
            `WITH
              vector_search AS (
                SELECT id, content, 1 - (embedding <=> $1::vector) AS vector_score
                FROM chunks
                ORDER BY embedding <=> $1::vector
                LIMIT 20
              ),
              text_search AS (
                SELECT id, content, ts_rank(search_vector, plainto_tsquery('simple', $2)) AS text_score
                FROM chunks
                WHERE search_vector @@ plainto_tsquery('simple', $2)
                ORDER BY text_score DESC
                LIMIT 20
              ),
              combined AS (
                SELECT
                  COALESCE(v.id, t.id) AS id,
                  COALESCE(v.content, t.content) AS content,
                  COALESCE(v.vector_score, 0) AS vector_score,
                  COALESCE(t.text_score, 0) AS text_score
                FROM vector_search v
                FULL OUTER JOIN text_search t ON v.id = t.id
              ),
              max_scores AS (
                SELECT MAX(vector_score) AS max_vector, MAX(text_score) AS max_text
                FROM combined
              ),
              scored AS (
                SELECT
                  c.id,
                  c.content,
                  ROUND(c.vector_score::numeric, 4) AS vector_score,
                  ROUND(c.text_score::numeric, 4) AS text_score,
                  ROUND(
                    (
                      (c.vector_score / NULLIF(m.max_vector, 0)) * 0.7 +
                      (c.text_score / NULLIF(m.max_text, 0)) * 0.3
                    )::numeric,
                    4
                  ) AS hybrid_score
                FROM combined c
                CROSS JOIN max_scores m
              )
            SELECT id, content, vector_score, text_score, hybrid_score
            FROM scored
            ORDER BY hybrid_score DESC NULLS LAST
            LIMIT 5`,
            [questionVector, question]
        );

        const topChunks = searchResult.rows;

        if (topChunks.length === 0) {
            return res.status(400).json({ error: 'Veritabanında hiç chunk yok, önce bir doküman yükleyin.' });
        }

        // 3. Threshold check
        const bestScore = parseFloat(topChunks[0].hybrid_score);
        let contextText;

        if (bestScore < 0.30) {
            contextText = 'Bu soruyla ilgili yüklenen dökümanda hiçbir bilgi bulunmamaktadır.';
        } else {
            contextText = topChunks.map((c, i) => `[Kaynak ${i + 1}]: ${c.content}`).join('\n\n');
        }

        console.log(`[Ask] Hibrit arama tamamlandı. En yüksek skor: ${bestScore}`);

        // 4. Send to LLM
        const systemPrompt = `Sen yardımcı bir yapay zeka asistanısın. Sadece sana verilen aşağıdaki kaynaklara sadık kalarak soruyu cevapla.\n\n${contextText}`;

        const chatResponse = await ollamaChat([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: question },
        ]);

        res.json({
            question,
            questionCacheHit,
            searchMode: 'hybrid',
            retrievedChunks: topChunks,
            answer: chatResponse.message.content,
        });

    } catch (error) {
        console.error('Soru cevaplama hatası:', error);
        res.status(500).json({ error: 'Soru cevaplanırken hata oluştu.', details: error.message });
    }
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`\n🚀 DocMind RAG Server running at http://localhost:${PORT}`);
    console.log(`📡 Ollama: ${OLLAMA_HOST}`);
    console.log('Endpoints:');
    console.log(`  POST http://localhost:${PORT}/upload`);
    console.log(`  GET  http://localhost:${PORT}/documents/:id/status`);
    console.log(`  POST http://localhost:${PORT}/ask\n`);
});