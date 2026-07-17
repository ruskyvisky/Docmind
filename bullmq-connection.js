const { default: IORedis } = require('ioredis');

// BullMQ, 'redis' paketi yerine 'ioredis' bağlantısı gerektirir.
// Queue ve Worker bu modülü paylaşarak tek bir bağlantı havuzu kullanır.
const connection = new IORedis({
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    // BullMQ blocking komutları kullandığı için maxRetriesPerRequest null olmalı
    maxRetriesPerRequest: null,
});

connection.on('connect', () => {
    console.log('[BullMQ/IORedis] Bağlantı başarılı ✓');
});

connection.on('error', (err) => {
    console.error('[BullMQ/IORedis] Bağlantı hatası:', err.message);
});

module.exports = connection;
