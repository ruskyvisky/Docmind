const express = require('express');
const ollama = require('ollama').default; // Resmi Ollama kütüphanesini içeri aktarıyoruz

const app = express();
app.use(express.json()); // Gelen JSON istek gövdelerini (body) okuyabilmek için middleware

// 1. Sabit Doküman Havuzumuz (Knowledge Base)
// Yapay zekanın hakkında hiçbir şey bilmediği varsayılan yerel bilgi havuzumuz.
const documents = [
    "JavaScript tek iş parçacıklı (single-threaded) çalışan, asenkron ve olay güdümlü bir programlama dilidir.",
    "Docker, uygulamalarınızı konteyner adı verilen izole ortamlarda çalıştırmanızı sağlayan bir platformdur.",
    "Node.js, JavaScript kodlarının tarayıcı dışında, sunucu tarafında da çalıştırılabilmesini sağlayan bir runtime ortamıdır.",
    "Express.js, Node.js üzerinde minimalist ve esnek web uygulamaları ile API'ler geliştirmek için kullanılan bir frameworktür.",
    "Kosinüs benzerliği (Cosine Similarity), iki vektör arasındaki açının kosinüsünü hesaplayarak aralarındaki yönsel benzerliği ölçer."
];

// 2. Kosinüs Benzerliği (Cosine Similarity) Fonksiyonu
// İki farklı metnin yapay zeka tarafından üretilen sayı dizilerini (vektörlerini) karşılaştırır.
function cosineSimilarity(vecA, vecB) {
    let dotProduct = 0.0;
    let normA = 0.0;
    let normB = 0.0;

    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }

    if (normA === 0 || normB === 0) return 0; // 0'a bölünme hatasını engellemek için güvenlik önlemi
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// 3. Ana İstek Noktamız (Endpoint)
app.post('/ask', async (req, res) => {
    const { question } = req.body; // Kullanıcının gönderdiği soruyu alıyoruz

    // Eğer istekte soru yoksa kullanıcıya hata dönüyoruz
    if (!question) {
        return res.status(400).json({ error: "Lütfen 'question' parametresini gönderin." });
    }

    try {
        console.log(`\nYeni Soru Geldi: "${question}"`);

        // ADIM A: Sorunun Vektörünü (Embedding) Oluşturma
        // Kullanıcının sorduğu soruyu alıp 'nomic-embed-text' modeline göndererek sayı dizisine çeviriyoruz.
        const questionEmbeddingResponse = await ollama.embeddings({
            model: 'nomic-embed-text',
            prompt: question
        });
        const questionEmbedding = questionEmbeddingResponse.embedding;

        // ADIM B: Dokümanları Tek Tek Vektöre Çevirme ve Kıyaslama
        const scoredDocuments = [];

        for (const doc of documents) {
            // Havuzdaki her bir dökümanı sırayla yapay zekaya gönderip sayı dizisine (embedding) çeviriyoruz.
            const docEmbeddingResponse = await ollama.embeddings({
                model: 'nomic-embed-text',
                prompt: doc
            });
            const docEmbedding = docEmbeddingResponse.embedding;

            // Az önce yazdığımız matematiksel fonksiyon ile sorunun vektörü ile dökümanın vektörünü kıyaslıyoruz.
            const similarity = cosineSimilarity(questionEmbedding, docEmbedding);

            // Sonucu ve dökümanı listemize ekliyoruz
            scoredDocuments.push({ doc, similarity });
        }

        // ADIM C: En Alakalı Dökümanı Bulma
        // Benzerlik skorlarına göre listeyi büyükten küçüğe sıralıyoruz.
        scoredDocuments.sort((a, b) => b.similarity - a.similarity);
        const bestMatch = scoredDocuments[0]; // En yüksek skora sahip olan ilk elemanı seçiyoruz.

        console.log(`En alakalı döküman bulundu: "${bestMatch.doc}" (Skor: ${bestMatch.similarity.toFixed(4)})`);

        // ADIM D: LLM (Llama) Modelini Besleme ve Cevap Üretme
        // Yapay zekaya bir rol biçiyoruz ve bulduğumuz en alakalı dökümanı ona "Kılavuz/Bağlam" olarak veriyoruz.
        const systemPrompt = `Sen yardımcı bir yapay zeka asistanısın. Sadece sana verilen aşağıdaki bağlama (Context) sadık kalarak soruyu cevapla. Eğer bağlamda bilgi yoksa kendi bilgini kullanma, bilmediğini söyle.
Bağlam: "${bestMatch.doc}"`;

        // Llama modeline hem sistemi (kuralları) hem de kullanıcının asıl sorusunu gönderiyoruz.
        const chatResponse = await ollama.chat({
            model: 'llama3.1:8b', // Eğer bilgisayarın güçlüyse 'llama3.1:8b' yazabilirsin.
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: question }
            ]
        });

        // ADIM E: Kullanıcıya Yanıtı Dönme
        res.json({
            question: question,
            retrievedContext: bestMatch.doc, // Yapay zekanın bulup okuduğu döküman
            similarityScore: bestMatch.similarity, // Matematiksel benzerlik oranı
            answer: chatResponse.message.content // Llama'nın ürettiği anlamlı cevap
        });

    } catch (error) {
        console.error("İşlem sırasında bir hata meydana geldi:", error);
        res.status(500).json({ error: "Sunucu içi bir hata oluştu.", details: error.message });
    }
});

// Sunucumuzu 3000 portunda çalıştırıyoruz
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`RAG Sunucusu http://localhost:${PORT} adresinde aktif!`);
});