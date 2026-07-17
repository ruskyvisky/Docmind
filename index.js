const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { Queue } = require('bullmq');
const ollama = require('ollama').default;
const pool = require('./db');
const redisClient = require('./redis');
const connection = require('./bullmq-connection');
const { getCachedEmbedding, setCachedEmbedding } = require('./utils');

// Worker'ı aynı süreçte başlat
require('./worker');

const app = express();
app.use(express.json());

// ==========================================
// MULTER — DISK STORAGE
// ==========================================
const UPLOADS_DIR = path.join(__dirname, 'uploads');

// uploads/ klasörü yoksa oluştur
if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    console.log('[Multer] uploads/ klasörü oluşturuldu.');
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, UPLOADS_DIR);
    },
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
// BULLMQ KUYRUK (PRODUCER)
// ==========================================
const ingestionQueue = new Queue('ingestion-queue', { connection });

// ==========================================
// ADIM 1: PDF YÜKLEME ENDPOINT'İ (PRODUCER)
// ==========================================
app.post('/upload', upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Lütfen bir PDF dosyası yükleyin.' });
    }

    try {
        const filePath = req.file.path;
        const originalName = req.file.originalname;

        // PostgreSQL'e "processing" durumuyla kayıt ekle
        const docResult = await pool.query(
            'INSERT INTO documents (filename, status) VALUES ($1, $2) RETURNING id',
            [originalName, 'processing']
        );
        const documentId = docResult.rows[0].id;

        // Kuyruğa iş ekle
        await ingestionQueue.add(
            'process-pdf',
            { documentId, filePath, originalName },
            {
                attempts: 3,                   // Hata olursa 3 kez dene
                backoff: {
                    type: 'exponential',
                    delay: 5000,               // 5s, 10s, 20s
                },
                removeOnComplete: 100,         // Son 100 tamamlanan işi tut
                removeOnFail: 50,              // Son 50 başarısız işi tut
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
// ADIM 2: DURUM SORGULAMA ENDPOINT'İ
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
// ADIM 3: SORU SORMA ENDPOINT'İ
// ==========================================
app.post('/ask', async (req, res) => {
    const { question } = req.body;

    if (!question) {
        return res.status(400).json({ error: "Lütfen 'question' parametresini gönderin." });
    }

    try {
        // Sorunun embedding'ini önce Redis'ten sorgula
        let questionEmbedding = await getCachedEmbedding(question);
        let questionCacheHit = false;

        if (questionEmbedding) {
            questionCacheHit = true;
            console.log("[Ask] Soru embedding'i Redis cache'ten alındı ✓");
        } else {
            const questionEmbeddingResponse = await ollama.embeddings({
                model: 'nomic-embed-text',
                prompt: question,
            });
            questionEmbedding = questionEmbeddingResponse.embedding;
            // Sonraki aynı soru için Redis'e kaydet
            await setCachedEmbedding(question, questionEmbedding);
            console.log("[Ask] Soru embedding'i Ollama'dan alındı ve önbelleğe kaydedildi.");
        }

        const questionVector = `[${questionEmbedding.join(',')}]`;

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
            return res.status(400).json({ error: 'Veritabanında hiç chunk yok, önce bir doküman yükleyin.' });
        }

        const bestScore = topChunks[0].similarity;
        let contextText;

        if (bestScore < 0.30) {
            contextText = 'Bu soruyla ilgili yüklenen dökümanda hiçbir bilgi bulunmamaktadır.';
        } else {
            contextText = topChunks
                .map((c, i) => `[Kaynak ${i + 1}]: ${c.content}`)
                .join('\n\n');
        }

        const systemPrompt = `Sen yardımcı bir yapay zeka asistanısın. Sadece sana verilen aşağıdaki kaynaklara sadık kalarak soruyu cevapla. Kaynaklar arasında birbiriyle alakasız olanlar olabilir, sadece soruyla ilgili olanı kullan. Eğer hiçbir kaynak sorunun cevabını içermiyorsa, kibarca 'Bu bilgi dökümanda yer almıyor' de.\n\n${contextText}`;

        const chatResponse = await ollama.chat({
            model: 'llama3.1:8b',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: question },
            ],
        });

        res.json({
            question,
            questionCacheHit,
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
    console.log(`\nRAG Sunucusu http://localhost:${PORT} adresinde aktif!`);
    console.log('Endpointler:');
    console.log(`  POST http://localhost:${PORT}/upload`);
    console.log(`  GET  http://localhost:${PORT}/documents/:id/status`);
    console.log(`  POST http://localhost:${PORT}/ask\n`);
});