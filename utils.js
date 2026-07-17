// utils.js - Text chunking & Embedding cache utilities
const crypto = require('crypto');
const redisClient = require('./redis');

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';

// ==========================================
// TEXT CHUNKING
// ==========================================
function chunkText(text, chunkSize = 500, overlap = 50) {
    const cleanText = text.replace(/\r\n/g, '\n').trim();
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
// REDIS EMBEDDING CACHE
// ==========================================
function getEmbeddingCacheKey(text) {
    const hash = crypto.createHash('sha256').update(text).digest('hex');
    return `embedding:${hash}`;
}

async function getCachedEmbedding(text) {
    try {
        const key = getEmbeddingCacheKey(text);
        const value = await redisClient.get(key);
        return value ? JSON.parse(value) : null;
    } catch (err) {
        console.warn('[Redis] getCachedEmbedding fallback:', err.message);
        return null;
    }
}

async function setCachedEmbedding(text, embedding) {
    try {
        const key = getEmbeddingCacheKey(text);
        await redisClient.set(key, JSON.stringify(embedding));
    } catch (err) {
        console.warn('[Redis] setCachedEmbedding fallback:', err.message);
    }
}

async function batchGetCachedEmbeddings(texts) {
    try {
        const keys = texts.map(getEmbeddingCacheKey);
        const values = await redisClient.mGet(keys);
        return values.map((v, i) => ({
            text: texts[i],
            embedding: v ? JSON.parse(v) : null,
        }));
    } catch (err) {
        console.warn('[Redis] batchGetCachedEmbeddings fallback:', err.message);
        return texts.map(text => ({ text, embedding: null }));
    }
}

async function batchSetCachedEmbeddings(pairs) {
    if (pairs.length === 0) return;
    try {
        const msetArgs = {};
        for (const { text, embedding } of pairs) {
            msetArgs[getEmbeddingCacheKey(text)] = JSON.stringify(embedding);
        }
        await redisClient.mSet(msetArgs);
    } catch (err) {
        console.warn('[Redis] batchSetCachedEmbeddings fallback:', err.message);
    }
}

// ==========================================
// OLLAMA API HELPERS (Custom Host Support)
// ==========================================
async function ollamaEmbed(prompt) {
    const response = await fetch(`${OLLAMA_HOST}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: 'nomic-embed-text',
            prompt
        })
    });
    if (!response.ok) throw new Error(`Ollama embed error: ${response.status}`);
    return response.json();
}

async function ollamaChat(messages) {
    const response = await fetch(`${OLLAMA_HOST}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: 'llama3.1:8b',
            messages,
            stream: false
        })
    });
    if (!response.ok) throw new Error(`Ollama chat error: ${response.status}`);
    const data = await response.json();
    return { message: { content: data.message.content } };
}

module.exports = {
    chunkText,
    getEmbeddingCacheKey,
    getCachedEmbedding,
    setCachedEmbedding,
    batchGetCachedEmbeddings,
    batchSetCachedEmbeddings,
    ollamaEmbed,
    ollamaChat,
    OLLAMA_HOST,
};