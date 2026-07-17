const { Worker } = require('bullmq');
const fs = require('fs');
const pdfParse = require('pdf-parse');
const ollama = require('ollama').default;
const pool = require('./db');
const connection = require('./bullmq-connection');
const {
    chunkText,
    batchGetCachedEmbeddings,
    batchSetCachedEmbeddings,
} = require('./utils');

const QUEUE_NAME = 'ingestion-queue';
const BATCH_SIZE = 5;

// ==========================================
// BULLMQ WORKER — PDF İŞLEME TÜK1ETİCİSİ
// ==========================================
const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
        const { documentId, filePath, originalName } = job.data;

        console.log(`\n[Worker] İş başladı → documentId=${documentId}, dosya="${originalName}"`);

        const client = await pool.connect();

        try {
            // ── 1. PDF'i diskten oku ──
            const fileBuffer = await fs.promises.readFile(filePath);
            const pdfData = await pdfParse(fileBuffer);
            const fullText = pdfData.text;

            if (!fullText || fullText.trim().length === 0) {
                throw new Error('PDF\'ten metin okunamadı veya boş.');
            }

            console.log(`[Worker] Metin okundu (${fullText.length} karakter). Parçalanıyor...`);

            // ── 2. Metni parçala ──
            const rawChunks = chunkText(fullText, 500, 50);
            console.log(`[Worker] ${rawChunks.length} chunk oluşturuldu. Embedding işlemi başlıyor...`);

            // ── 3. Transaction başlat ──
            await client.query('BEGIN');

            let totalCacheHits = 0;
            let totalCacheMisses = 0;

            // ── 4. Batch embedding (Redis cache + Ollama) ──
            for (let i = 0; i < rawChunks.length; i += BATCH_SIZE) {
                const batch = rawChunks.slice(i, i + BATCH_SIZE);

                // SORGULAMA FAZI: Redis'e toplu sor
                const cacheResults = await batchGetCachedEmbeddings(batch);

                // KARAR FAZI: Hit / Miss ayır
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

                // OLLAMA FAZI: Sadece cache miss olanları Ollama'ya gönder
                let freshResults = [];
                if (misses.length > 0) {
                    const ollamaPromises = misses.map(async ({ idx, text }) => {
                        const embeddingResponse = await ollama.embeddings({
                            model: 'nomic-embed-text',
                            prompt: text,
                        });
                        return { idx, text, embedding: embeddingResponse.embedding };
                    });
                    freshResults = await Promise.all(ollamaPromises);
                }

                // YENİ EMBEDDİNG'LERİ Redis'e kaydet
                if (freshResults.length > 0) {
                    await batchSetCachedEmbeddings(
                        freshResults.map(({ text, embedding }) => ({ text, embedding }))
                    );
                }

                // BİRLEŞTİR: Orijinal sırayı koru
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

                // BullMQ job ilerleme bilgisi
                const progress = Math.round(((i + batch.length) / rawChunks.length) * 100);
                await job.updateProgress(progress);
                console.log(`[Worker] İlerleme: ${progress}% (Cache → Hit: ${totalCacheHits}, Miss: ${totalCacheMisses})`);
            }

            // ── 5. Transaction tamamla ──
            await client.query('COMMIT');

            // ── 6. Durum: completed ──
            await pool.query(
                'UPDATE documents SET status = $1 WHERE id = $2',
                ['completed', documentId]
            );

            console.log(`[Worker] ✓ documentId=${documentId} işlendi. Cache istatistikleri → Hit: ${totalCacheHits}, Miss: ${totalCacheMisses}`);

        } catch (error) {
            await client.query('ROLLBACK');

            // Durum: failed
            await pool.query(
                'UPDATE documents SET status = $1 WHERE id = $2',
                ['failed', documentId]
            );

            console.error(`[Worker] ✗ documentId=${documentId} işlenirken hata:`, error.message);

            // Hatayı yeniden fırlatarak BullMQ'nun retry mekanizmasını tetikle
            throw error;

        } finally {
            client.release();

            // ── 7. Geçici dosyayı her durumda sil ──
            try {
                await fs.promises.unlink(filePath);
                console.log(`[Worker] Geçici dosya silindi: ${filePath}`);
            } catch (unlinkErr) {
                // Dosya zaten silinmiş olabilir, kritik değil
                console.warn(`[Worker] Geçici dosya silinirken uyarı: ${unlinkErr.message}`);
            }
        }
    },
    {
        connection,
        concurrency: 2, // Aynı anda max 2 PDF işlenir, diğerleri kuyrukta bekler
    }
);

// ==========================================
// WORKER OLAY DİNLEYİCİLERİ
// ==========================================
worker.on('completed', (job) => {
    console.log(`[Worker] İş tamamlandı ✓ — jobId=${job.id}, documentId=${job.data.documentId}`);
});

worker.on('failed', (job, err) => {
    console.error(`[Worker] İş başarısız ✗ — jobId=${job?.id}, documentId=${job?.data?.documentId}, hata: ${err.message}`);
});

worker.on('error', (err) => {
    console.error('[Worker] Worker genel hatası:', err.message);
});

console.log(`[Worker] "${QUEUE_NAME}" kuyruğu dinleniyor (concurrency: 2)...`);

module.exports = worker;
