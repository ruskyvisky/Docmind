const express = require('express');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const ollama = require('ollama').default;
const crypto = require('crypto');
const pool = require('./db');
const redisClient = require('./redis');

const app = express();
app.use(express.json());

// Bellek tabanlı dosya yükleme ayarı
const upload = multer({ storage: multer.memoryStorage() });

// ==========================================
// YARDIMCI FONKSİYONLAR
// ==========================================

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

/**
 * Verilen metin için SHA-256 hash üretir ve Redis namespace'i döner.
 * Örnek: "embedding:4a8f9c2b..."
 */
function getEmbeddingCacheKey(text) {
    const hash = crypto.createHash('sha256').update(text).digest('hex');
    return `embedding:${hash}`;
}

/**
 * Redis'ten tek bir embedding çeker. Redis down ise null döner (fallback).
 */
async function getCachedEmbedding(text) {
    try {
        const key = getEmbeddingCacheKey(text);
        const value = await redisClient.get(key);
        if (value) return JSON.parse(value);
        return null;
    } catch (err) {
        console.warn('[Redis] getCachedEmbedding hatası (fallback aktif):', err.message);
        return null;
    }
}

/**
 * Bir embedding'i Redis'e kaydeder. Redis down ise sessizce geçer.
 */
async function setCachedEmbedding(text, embedding) {
    try {
        const key = getEmbeddingCacheKey(text);
        await redisClient.set(key, JSON.stringify(embedding));
    } catch (err) {
        console.warn('[Redis] setCachedEmbedding hatası (fallback aktif):', err.message);
    }
}

/**
 * Bir batch (dizi) metin için Redis'te MGET ile toplu sorgulama yapar.
 * Dönen dizi: her index için { text, embedding } | null
 * Redis down ise hepsi null döner (fallback).
 */
async function batchGetCachedEmbeddings(texts) {
    try {
        const keys = texts.map(getEmbeddingCacheKey);
        const values = await redisClient.mGet(keys);
        return values.map((v, i) => ({
            text: texts[i],
            embedding: v ? JSON.parse(v) : null,
        }));
    } catch (err) {
        console.warn('[Redis] MGET hatası (fallback aktif):', err.message);
        return texts.map(text => ({ text, embedding: null }));
    }
}

/**
 * Birden fazla embedding'i Redis'e toplu kaydeder (MSET).
 * Redis down ise sessizce geçer.
 */
async function batchSetCachedEmbeddings(pairs) {
    // pairs: [{ text, embedding }, ...]
    if (pairs.length === 0) return;
    try {
        const msetArgs = {};
        for (const { text, embedding } of pairs) {
            msetArgs[getEmbeddingCacheKey(text)] = JSON.stringify(embedding);
        }
        await redisClient.mSet(msetArgs);
    } catch (err) {
        console.warn('[Redis] MSET hatası (fallback aktif):', err.message);
    }
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

        let totalCacheHits = 0;
        let totalCacheMisses = 0;

        for (let i = 0; i < rawChunks.length; i += BATCH_SIZE) {
            const batch = rawChunks.slice(i, i + BATCH_SIZE);

            // ── SORGULAMA FAZI: Tek MGET ile hepsini Redis'e sor ──
            const cacheResults = await batchGetCachedEmbeddings(batch);

            // ── KARAR FAZI: Hit / Miss ayır ──
            const hits = [];   // { idx, text, embedding }
            const misses = []; // { idx, text }

            cacheResults.forEach(({ text, embedding }, localIdx) => {
                const globalIdx = i + localIdx;
                if (embedding !== null) {
                    hits.push({ idx: globalIdx, text, embedding });
                    totalCacheHits++;
                } else {
                    misses.push({ idx: globalIdx, text });
                    totalCacheMisses++;
                }
            });

            // ── OLLAMA FAZI: Sadece miss olanları Ollama'ya gönder ──
            let freshResults = []; // { idx, text, embedding }
            if (misses.length > 0) {
                const ollamaPromises = misses.map(async ({ idx, text }) => {
                    const embeddingResponse = await ollama.embeddings({
                        model: 'nomic-embed-text',
                        prompt: text
                    });
                    return { idx, text, embedding: embeddingResponse.embedding };
                });
                freshResults = await Promise.all(ollamaPromises);
            }

            // ── KAYDETME FAZI: Yeni embedding'leri Redis'e toplu kaydet ──
            if (freshResults.length > 0) {
                await batchSetCachedEmbeddings(
                    freshResults.map(({ text, embedding }) => ({ text, embedding }))
                );
            }

            // ── BİRLEŞTİRME: Orijinal sırayı koru ──
            const allResults = [...hits, ...freshResults];
            allResults.sort((a, b) => a.idx - b.idx);

            // PostgreSQL'e yaz
            for (const item of allResults) {
                const vectorString = `[${item.embedding.join(',')}]`;
                await client.query(
                    'INSERT INTO chunks (document_id, content, embedding, chunk_index) VALUES ($1, $2, $3, $4)',
                    [documentId, item.text, vectorString, item.idx]
                );
            }
        }

        await client.query('COMMIT');

        console.log(`[Upload] Cache istatistikleri → Hit: ${totalCacheHits}, Miss: ${totalCacheMisses}`);

        res.json({
            message: "PDF başarıyla yüklendi ve veritabanına kaydedildi!",
            documentId,
            totalChunks: rawChunks.length,
            cacheStats: { hits: totalCacheHits, misses: totalCacheMisses }
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
// ADIM 2: SORU SORMA ENDPOINT'İ
// ==========================================
app.post('/ask', async (req, res) => {
    const { question } = req.body;

    if (!question) {
        return res.status(400).json({ error: "Lütfen 'question' parametresini gönderin." });
    }

    try {
        // ── Sorunun embedding'ini önce Redis'ten sorgula (Bonus) ──
        let questionEmbedding = await getCachedEmbedding(question);
        let questionCacheHit = false;

        if (questionEmbedding) {
            questionCacheHit = true;
            console.log('[Ask] Soru embedding\'i Redis cache\'ten alındı ✓');
        } else {
            const questionEmbeddingResponse = await ollama.embeddings({
                model: 'nomic-embed-text',
                prompt: question
            });
            questionEmbedding = questionEmbeddingResponse.embedding;
            // Sonraki aynı soru için Redis'e kaydet
            await setCachedEmbedding(question, questionEmbedding);
            console.log('[Ask] Soru embedding\'i Ollama\'dan alındı ve önbelleğe kaydedildi.');
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
            questionCacheHit,
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