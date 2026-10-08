-- Search (issue #4, step 6), full-text part. Text is extracted per blob, not
-- per file: blobs are content-addressed, so every version, every experiment's
-- copy and every duplicate of the same bytes shares one index entry. A query
-- finds files whose current version's blob matches, then keeps the ones the
-- user may read (search.ts).

-- Substring matching, for words full-text search doesn't split well
-- (CJK, part numbers, partial words).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- A blob whose text has been extracted; chars = 0 for binary or empty content.
-- Its presence means "done", so the background indexer skips it.
CREATE TABLE blob_texts (
  sha256     text PRIMARY KEY REFERENCES blobs(sha256),
  chars      integer NOT NULL CHECK (chars >= 0),
  indexed_at timestamptz NOT NULL DEFAULT now()
);

-- The text in pieces of about a paragraph or a few, so a hit can show the
-- passage that matched (and, later, each piece gets an embedding).
CREATE TABLE blob_chunks (
  sha256 text NOT NULL REFERENCES blob_texts(sha256) ON DELETE CASCADE,
  ord    integer NOT NULL CHECK (ord >= 0),
  body   text NOT NULL,
  tsv    tsvector GENERATED ALWAYS AS (to_tsvector('english', body)) STORED,
  PRIMARY KEY (sha256, ord)
);

CREATE INDEX blob_chunks_tsv ON blob_chunks USING gin (tsv);
CREATE INDEX blob_chunks_trgm ON blob_chunks USING gin (body gin_trgm_ops);
CREATE INDEX files_path_trgm ON files USING gin (path gin_trgm_ops) WHERE deleted_at IS NULL;
CREATE INDEX file_versions_by_blob ON file_versions (blob_sha256);

-- Steps between two places in the knowledge tree (node paths; '' = root), so
-- results near where the user is working rank first.
CREATE FUNCTION tree_distance(a ltree, b ltree) RETURNS integer
  LANGUAGE sql IMMUTABLE AS $$
  SELECT nlevel(a) + nlevel(b) - 2 * coalesce(max(k), 0)
  FROM generate_series(1, least(nlevel(a), nlevel(b))) AS k
  WHERE subpath(a, 0, k) = subpath(b, 0, k)
$$;

-- Row-level security (see 004_row_security.sql): a blob's text is readable by
-- whoever can read a version holding it, and is added along with a version
-- the user may write. The subqueries see versions through their own policies.
ALTER TABLE blob_texts ENABLE ROW LEVEL SECURITY;
ALTER TABLE blob_chunks ENABLE ROW LEVEL SECURITY;

CREATE POLICY blob_texts_read ON blob_texts FOR SELECT
  USING (EXISTS (SELECT 1 FROM file_versions v WHERE v.blob_sha256 = sha256));
CREATE POLICY blob_texts_add ON blob_texts FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM file_versions v JOIN files f ON f.id = v.file_id
    WHERE v.blob_sha256 = sha256
      AND place_rank(f.workspace_id, app_user(), f.node_id, f.experiment_id) >= 2));

CREATE POLICY blob_chunks_read ON blob_chunks FOR SELECT
  USING (EXISTS (SELECT 1 FROM file_versions v WHERE v.blob_sha256 = sha256));
CREATE POLICY blob_chunks_add ON blob_chunks FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM file_versions v JOIN files f ON f.id = v.file_id
    WHERE v.blob_sha256 = sha256
      AND place_rank(f.workspace_id, app_user(), f.node_id, f.experiment_id) >= 2));
