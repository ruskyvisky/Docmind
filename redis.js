const { createClient } = require('redis');

const client = createClient({
    socket: {
        host: 'localhost',
        port: 6379,
    }
});

client.on('error', (err) => {
    // Bağlantı kopsa da uygulama çökmez; sadece loglayıp devam eder
    console.error('[Redis] Bağlantı hatası:', err.message);
});

// Uygulama başlarken bağlan
client.connect()
    .then(() => {
        console.log('[Redis] Bağlantı başarılı! ✓');
    })
    .catch((err) => {
        console.error('[Redis] İlk bağlantı denemesi başarısız:', err.message);
        // Hata fırlatmıyoruz → uygulama ayakta kalmaya devam eder
    });

module.exports = client;
