-- Workspace file storage. File bytes live in the object store under their
-- sha256 (see blobs.ts); everything here is metadata we query.

CREATE TABLE workspaces (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       text NOT NULL UNIQUE,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Single-user for now; memberships and row-level security come with login.
INSERT INTO workspaces (slug, name) VALUES ('default', 'My workspace');

-- One row per distinct content. Immutable, so any number of versions and
-- files can point at the same blob.
CREATE TABLE blobs (
  sha256     text PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size       bigint NOT NULL CHECK (size >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE files (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  path               text NOT NULL CHECK (path <> '' AND path !~ '^/' AND path !~ '//'),
  -- Top-level folder decides the kind, mirroring the UI's left rail.
  kind               text NOT NULL CHECK (kind IN ('note', 'skill', 'upload', 'artifact')),
  mime               text NOT NULL,
  current_version_id uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  -- Soft delete keeps history; a new file may reuse the path afterwards.
  deleted_at         timestamptz
);

CREATE UNIQUE INDEX files_live_path ON files (workspace_id, path) WHERE deleted_at IS NULL;

CREATE TABLE file_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id     uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  blob_sha256 text NOT NULL REFERENCES blobs(sha256),
  size        bigint NOT NULL,
  mime        text NOT NULL,
  author_type text NOT NULL CHECK (author_type IN ('user', 'agent')),
  author_id   text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX file_versions_by_file ON file_versions (file_id, created_at DESC);

ALTER TABLE files
  ADD CONSTRAINT files_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES file_versions(id);
