-- DOCMIND — FTS Migration Script
BEGIN;

ALTER TABLE chunks ADD COLUMN IF NOT EXISTS search_vector tsvector;

CREATE OR REPLACE FUNCTION chunks_search_vector_update()
RETURNS TRIGGER AS $$
BEGIN
    NEW.search_vector := to_tsvector('simple', COALESCE(NEW.content, ''));
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_chunks_search_vector ON chunks;

CREATE TRIGGER trg_chunks_search_vector
    BEFORE INSERT OR UPDATE OF content
    ON chunks
    FOR EACH ROW
    EXECUTE FUNCTION chunks_search_vector_update();

CREATE INDEX IF NOT EXISTS chunks_search_vector_idx ON chunks USING GIN (search_vector);

CREATE INDEX IF NOT EXISTS chunks_embedding_idx ON chunks USING hnsw (embedding vector_cosine_ops);

UPDATE chunks SET search_vector = to_tsvector('simple', COALESCE(content, '')) WHERE search_vector IS NULL;

COMMIT;

SELECT COUNT(*) AS total_chunks, COUNT(search_vector) AS with_fts FROM chunks;
