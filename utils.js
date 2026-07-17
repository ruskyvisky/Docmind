const crypto = require('crypto');
const redisClient = require('./redis');

// ==========================================
// METİN PARÇALAMA FONKSİYONU
// ==========================================
/**
 * Uzun bir metni belirtilen boyut ve örtüşme miktarına göre parçalara böler.
 * Önce "Bölüm X:" gibi başlıklara göre bölümlere ayırır.
 */
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
// REDİS EMBEDDİNG CACHE YARDIMCILARI
// ==========================================

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

module.exports = {
    chunkText,
    getEmbeddingCacheKey,
    getCachedEmbedding,
    setCachedEmbedding,
    batchGetCachedEmbeddings,
    batchSetCachedEmbeddings,
};
