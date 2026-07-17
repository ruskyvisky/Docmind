// redis.js - Redis Connection
const { createClient } = require('redis');

const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = process.env.REDIS_PORT || 6379;

const client = createClient({
    socket: {
        host: REDIS_HOST,
        port: REDIS_PORT,
    }
});

client.on('error', (err) => {
    console.error('[Redis] Connection error:', err.message);
});

client.connect()
    .then(() => {
        console.log(`[Redis] Connected to ${REDIS_HOST}:${REDIS_PORT} ✓`);
    })
    .catch((err) => {
        console.error('[Redis] Initial connection failed:', err.message);
    });

module.exports = client;