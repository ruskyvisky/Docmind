# 🧠 DocMind

**DocMind**, PDF belgelerini yükleyip üzerlerine doğal dilde soru sormanı sağlayan, tamamen yerel çalışan ve gizlilik odaklı bir **RAG (Retrieval-Augmented Generation)** sistemidir. Embedding üretimi ve LLM çıkarımı dahil tüm işlemler, [Ollama](https://ollama.com/) aracılığıyla kendi makinende gerçekleşir. Hiçbir veri dışarıya çıkmaz.

---

## 📋 İçindekiler

- [Nasıl Çalışır](#-nasıl-çalışır)
- [Özellikler](#-özellikler)
- [Teknoloji Yığını](#-teknoloji-yığını)
- [Mimari](#-mimari)
- [Proje Yapısı](#-proje-yapısı)
- [Gereksinimler](#-gereksinimler)
- [Kurulum](#-kurulum)
- [Örnek Kullanımlar](#-örnek-kullanımlar)
- [API Referansı](#-api-referansı)
- [Tasarım Kararları](#-tasarım-kararları)

---

## ⚙️ Nasıl Çalışır

DocMind, üstünde **Hibrit Arama** katmanı bulunan klasik bir RAG pipeline'ı uygular:

```
PDF Yükleme
    │
    ▼
[BullMQ Kuyruğu]          ← Asenkron iş kuyruğu, yükleme anında dönüş
    │
    ▼
[Worker: PDF Ayrıştırma]  ← pdf-parse ile ham metin çıkarma
    │
    ▼
[Metin Parçalama]         ← Kayan pencere (500 karakter, 50 örtüşme)
    │
    ▼
[Embedding Üretimi]       ← nomic-embed-text via Ollama (768 boyutlu vektör)
    │      ↑
    │   [Redis Cache]     ← SHA-256 anahtarlı önbellek → tekrar embedding'i önler
    │
    ▼
[PostgreSQL]              ← chunk'lar + pgvector embedding'leri + tsvector FTS
    │
    ▼
[/ask endpoint'i]
    │
    ├─ Vektör Araması   (pgvector cosine benzerliği, HNSW indeksi)
    ├─ Tam Metin Arama  (PostgreSQL tsvector + GIN indeksi)
    └─ Hibrit Füzyon    (min-max normalize, ağırlıklı: %70 vektör + %30 FTS)
         │
         ▼
    [LLM: llama3.1:8b]  ← Bağlam enjekte edilmiş prompt, SSE ile token token akış
```

---

## ✨ Özellikler

| Özellik | Detay |
|---|---|
| **PDF Yükleme** | REST API üzerinden PDF yükleme; arka planda asenkron işleme |
| **Asenkron Kuyruk** | Üstel geri çekilme ile yeniden deneme (maks. 3 deneme) destekli BullMQ kuyruğu |
| **Akıllı Parçalama** | Bölüm algılamalı, kayan pencere chunking (500 karakter, 50 karakter örtüşme) |
| **Vektör Embedding** | Ollama üzerinden `nomic-embed-text` ile üretilen 768 boyutlu vektörler |
| **Hibrit Arama** | Anlamsal (pgvector cosine) ve anahtar kelime (PostgreSQL FTS) sonuçlarını birleştirir |
| **Skor Normalizasyonu** | Min-max normalizasyonu ile vektör ve metin skorları adil biçimde karşılaştırılır |
| **Alaka Eşiği** | `hybrid_score < 0.30` durumunda halüsinasyonu önlemek için yanıt engellenir |
| **Embedding Önbelleği** | Redis, SHA-256 hash ile embedding'leri önbelleğe alır — tekli ve toplu (`MGET`/`MSET`) |
| **Akışlı Yanıtlar** | LLM yanıtları Server-Sent Events (SSE) ile token token akar |
| **Tam Yerel Çalışma** | Sıfır bulut bağımlılığı; tüm yapay zeka yerel Ollama üzerinde çalışır |
| **Docker ile Paketlenmiş** | `docker compose up` ile tek komut dağıtım |
| **Eşzamanlılık Kontrolü** | Worker aynı anda en fazla 2 PDF işler; diğerleri kuyrukta bekler |

---

## 🛠️ Teknoloji Yığını

### Backend
| Paket | Versiyon | Rol |
|---|---|---|
| `express` | ^5.2.1 | REST API sunucusu |
| `bullmq` | ^5.80.6 | Redis destekli iş kuyruğu |
| `pg` | ^8.22.0 | PostgreSQL istemcisi (bağlantı havuzu) |
| `redis` | ^6.1.0 | Embedding önbelleği istemcisi |
| `pdf-parse` | ^1.1.1 | PDF metin çıkarma |
| `multer` | ^2.2.0 | Multipart dosya yükleme |
| `uuid` | ^14.0.1 | Benzersiz dosya adı üretimi |
| `ollama` | ^0.6.3 | Ollama SDK (worker'da embedding üretimi) |

### Altyapı
| Servis | İmaj | Rol |
|---|---|---|
| **PostgreSQL 16** | `pgvector/pgvector:pg16` | Belge ve chunk depolama, vektör + FTS araması |
| **Redis** | `redis:alpine` | İş kuyruğu broker'ı + embedding önbelleği |
| **Ollama** | *(host-native)* | `nomic-embed-text` (embedding) + `llama3.1:8b` (sohbet) |

### Veritabanı Uzantıları ve İndeksler
- **pgvector** — 768 boyutlu float vektörleri depolar ve sorgular
- **HNSW indeksi** — hızlı cosine benzerlik araması için yaklaşık en yakın komşu
- **GIN indeksi** — `tsvector` kolonu üzerinde PostgreSQL tam metin araması için ters indeks
- **Trigger** — Her `INSERT`/`UPDATE` işleminde `search_vector` kolonunu otomatik günceller

---

## 🏗️ Mimari

```
┌─────────────────────────────────────────────┐
│              Docker Compose                 │
│                                             │
│  ┌──────────┐   ┌──────────┐               │
│  │ Node.js  │──▶│  Redis   │               │
│  │ (Express │   │ (Kuyruk +│               │
│  │+ Worker) │   │  Önbel.) │               │
│  └────┬─────┘   └──────────┘               │
│       │                                     │
│       ▼                                     │
│  ┌──────────┐                               │
│  │ Postgres │ (pgvector + FTS)              │
│  └──────────┘                               │
│                                             │
└──────────────────┬──────────────────────────┘
                   │ host.docker.internal
                   ▼
         ┌─────────────────┐
         │  Ollama (Host)  │
         │ nomic-embed-text│
         │  llama3.1:8b    │
         └─────────────────┘
```

Node.js uygulaması ve BullMQ Worker **aynı süreçte** çalışır (`index.js`, `worker.js`'i require eder). Worker, Ollama'ya `host.docker.internal` üzerinden bağlanır; bu sayede Windows host'unda zaten indirilmiş modeller yeniden kullanılır — Docker içinde tekrar indirme gerekmez.

---

## 📁 Proje Yapısı

```
docmind/
├── index.js              # Express API sunucusu + route handler'ları
├── worker.js             # BullMQ worker (PDF → chunk → embed → kaydet)
├── utils.js              # Metin parçalayıcı, Redis önbellek yardımcıları, Ollama API sarmalayıcıları
├── db.js                 # PostgreSQL bağlantı havuzu (pg)
├── redis.js              # Redis istemcisi
├── bullmq-connection.js  # Paylaşılan BullMQ bağlantı ayarları
├── init.sql              # Veritabanı şeması: tablolar, trigger, HNSW + GIN indeksleri
├── index.html            # Minimal frontend (SSE destekli akışlı arayüz)
├── dockerfile            # Node 20 Alpine imajı
├── docker-compose.yml    # Postgres, Redis ve uygulamayı orkestre eder
├── package.json
└── uploads/              # Geçici PDF depolama (işlem sonrası otomatik temizlenir)
```

---

## 📦 Gereksinimler

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Compose v2 ile)
- Host makinende kurulu ve çalışan [Ollama](https://ollama.com/)
- Ollama'da aşağıdaki modeller indirilmiş olmalı:

```bash
ollama pull nomic-embed-text   # Embedding modeli (768 boyutlu)
ollama pull llama3.1:8b        # Sohbet / üretim modeli
```

---

## 🚀 Kurulum

### 1. Depoyu klonla

```bash
git clone https://github.com/kullanici-adin/docmind.git
cd docmind
```

### 2. Tüm servisleri başlat

```bash
docker compose up --build
```

Bu komut:
- `pgvector` destekli PostgreSQL'i başlatır ve `init.sql`'i otomatik çalıştırır (tabloları, indeksleri ve trigger'ı oluşturur)
- Redis'i başlatır
- Node.js uygulamasını derleyip başlatır

Uygulama **http://localhost:3000** adresinde erişilebilir olacak.

### 3. Ollama'nın erişilebilir olduğunu doğrula

Uygulama, Ollama'ya `http://host.docker.internal:11434` üzerinden bağlanır. Ollama'nın host makinende çalıştığından emin ol:

```bash
ollama serve   # Zaten çalışmıyorsa
```

---

## 📖 Örnek Kullanımlar

### PDF belgesi yükle

```bash
curl -X POST http://localhost:3000/upload \
  -F "file=@belge.pdf"
```

**Yanıt:**
```json
{
  "message": "Dosya yükleme işlemi arka planda başlatıldı.",
  "documentId": 1,
  "status": "processing"
}
```

Belge anında kuyruğa alınır. API `202 Accepted` ile hemen döner — parçalama ve embedding arka planda asenkron çalışır.

---

### İşlem durumunu sorgula

```bash
curl http://localhost:3000/documents/1/status
```

**İşlem sürerken:**
```json
{
  "documentId": 1,
  "filename": "raporum.pdf",
  "status": "processing",
  "uploadedAt": "2026-07-17T20:00:00.000Z"
}
```

**Tamamlandığında:**
```json
{
  "documentId": 1,
  "filename": "raporum.pdf",
  "status": "completed",
  "uploadedAt": "2026-07-17T20:00:00.000Z"
}
```

Olası durumlar: `processing` → `completed` | `failed`

---

### Soru sor (Server-Sent Events)

```bash
curl -X POST http://localhost:3000/ask \
  -H "Content-Type: application/json" \
  -d '{"question": "Raporun temel bulguları nelerdir?"}'
```

Yanıt SSE event'leri olarak akar:

```
event: metadata
data: {"question":"...","searchMode":"hybrid","bestScore":0.8543,"retrievedChunks":[...]}

event: token
data: {"token":"Raporun"}

event: token
data: {"token":" temel"}

event: token
data: {"token":" bulguları..."}

event: done
data: {"fullAnswer":"Raporun temel bulguları...", "done": true}
```

### Web Arayüzü

`index.html`'i doğrudan tarayıcında aç ve gerçek zamanlı akışlı arayüzü kullanarak belge yükle, soru sor.

---

## 📡 API Referansı

| Metot | Endpoint | Açıklama |
|---|---|---|
| `POST` | `/upload` | PDF dosyası yükle (`multipart/form-data`, alan: `file`) |
| `GET` | `/documents/:id/status` | Bir belgenin işlem durumunu sorgula |
| `POST` | `/ask` | Soru sor; SSE akışı olarak yanıt döner |

### SSE Event Tipleri (`/ask`)

| Event | Veri | Açıklama |
|---|---|---|
| `metadata` | `{ question, searchMode, bestScore, retrievedChunks, questionCacheHit }` | Yanıt başlamadan önce arama meta verisi |
| `token` | `{ token }` | LLM'den gelen tek bir akışlı metin token'ı |
| `done` | `{ fullAnswer, done: true }` | Akış tamamlandıktan sonra tam yanıt |
| `error` | `{ error, details }` | Akış sırasında hata |

---

## 🧩 Tasarım Kararları

### Neden Hibrit Arama?
Saf vektör araması anlamsal benzerlikte mükemmeldir ancak tam anahtar kelime eşleşmelerini kaçırabilir. Tam metin araması anahtar kelimeleri yakalar ama anlam kavrayamaz. İkisini birleştirmek — **min-max normalizasyonu** ve **70/30 ağırlıklı skor** ile — farklı soru tiplerine karşı daha sağlam bir geri getirme sağlar.

### Neden BullMQ + Redis?
PDF işleme (ayrıştırma → parçalama → Ollama üzerinden toplu embedding) CPU ve I/O açısından yoğundur. Bunu request handler'ında senkron yapmak büyük PDF'lerde zaman aşımına yol açar. BullMQ; yükleme işlemini HTTP katmanından ayırır, üstel geri çekilmeli yeniden deneme mantığı sağlar ve eşzamanlılığı kontrol etmeye (aynı anda 2 iş) imkân tanır.

### Neden Redis Embedding Önbelleği?
Ollama aracılığıyla embedding üretmek chunk başına yaklaşık 50–200ms sürer. Aynı içeriği yeniden işlemek (örn. bir belgeyi iki kez yüklemek) israf olur. Her chunk metninin SHA-256 hash'ini önbellek anahtarı olarak kullanmak, aynı içeriğin yalnızca bir kez embed edilmesini sağlar. Toplu `MGET`/`MSET` işlemleri de round-trip sayısını en aza indirir.

### Neden IVFFlat Değil de HNSW?
HNSW (Hierarchical Navigable Small World), biraz daha yüksek derleme süresi ve bellek maliyetiyle sorgu zamanında daha iyi performans sunar. Arama gecikmesinin indeks derleme hızından daha önemli olduğu bir belge soru-cevap kullanım senaryosu için HNSW doğru tercihtir.

### Neden Docker'laştırılmış Ollama Değil de Host-Native?
Ollama'yı Docker container içinde çalıştırmak büyük model dosyalarının yeniden indirilmesini gerektirir. `host.docker.internal` üzerinden host makinenin Ollama örneğine bağlanarak modeller geliştirme ortamı ile container arasında paylaşılır — yineleme yok, fazladan kurulum yok.

---

## 📄 Lisans

ISC
