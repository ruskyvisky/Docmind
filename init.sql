-- ============================================================
-- DOCMIND — Database Initialization Script
-- RAG (Retrieval-Augmented Generation) System
-- ============================================================

-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- ==========================================
-- TABLE: documents
-- Stores uploaded PDF metadata
-- ==========================================
CREATE TABLE IF NOT EXISTS documents (
    id SERIAL PRIMARY KEY,
    filename TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'processing',
    uploaded_at TIMESTAMPTZ DEFAULT now()
);

-- ==========================================
-- TABLE: chunks
-- Stores text chunks with vector embeddings
-- ==========================================
CREATE TABLE IF NOT EXISTS chunks (
    id SERIAL PRIMARY KEY,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    embedding vector(768),              -- nomic-embed-text dimension
    chunk_index INTEGER NOT NULL,
    search_vector tsvector,             -- Full-Text Search vector
    created_at TIMESTAMPTZ DEFAULT now()
);

-- ==========================================
-- TRIGGER FUNCTION: Auto-update search_vector
-- Converts content to tsvector on INSERT/UPDATE
-- ==========================================
CREATE OR REPLACE FUNCTION chunks_search_vector_update()
RETURNS TRIGGER AS $$
BEGIN
    NEW.search_vector := to_tsvector('simple', COALESCE(NEW.content, ''));
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ==========================================
-- TRIGGER: Execute on content changes
-- ==========================================
DROP TRIGGER IF EXISTS trg_chunks_search_vector ON chunks;
CREATE TRIGGER trg_chunks_search_vector
    BEFORE INSERT OR UPDATE OF content
    ON chunks
    FOR EACH ROW
    EXECUTE FUNCTION chunks_search_vector_update();

-- ==========================================
-- INDEX 1: HNSW for vector similarity search
-- Lightning-fast cosine similarity queries
-- ==========================================
CREATE INDEX IF NOT EXISTS chunks_embedding_idx 
    ON chunks USING hnsw (embedding vector_cosine_ops);

-- ==========================================
-- INDEX 2: GIN for Full-Text Search
-- Word-based search acceleration
-- ==========================================
CREATE INDEX IF NOT EXISTS chunks_search_vector_idx 
    ON chunks USING GIN (search_vector);

-- ==========================================
-- Backfill existing data (if any)
-- ==========================================
UPDATE chunks
SET search_vector = to_tsvector('simple', COALESCE(content, ''))
WHERE search_vector IS NULL;