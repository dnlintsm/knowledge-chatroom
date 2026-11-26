-- Pipelines (docs/pipeline-identities.md): named, revocable identities for
-- work that runs on its own. A pipeline acts for its owner, a member of the
-- workspace, narrowed to its places and operations, and holds keys that are
-- looked up on every request, so revoking one takes effect at the next.
--
-- Like workspace membership, these are administration, not content: the
-- routes read and write them with the app's own connection and check who may
-- (api_py/pipelines.py). Only a key's SHA-256 is kept.

CREATE TABLE pipelines (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (btrim(name) <> '' AND char_length(name) <= 200),
  owner_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  -- NULL for the whole workspace, or [{"node": id} | {"experiment": id}].
  places       jsonb CHECK (places IS NULL OR jsonb_typeof(places) = 'array'),
  operations   text[] NOT NULL CHECK (
                 cardinality(operations) > 0
                 AND operations <@ ARRAY['read', 'write', 'runs', 'upload']),
  created_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz,
  revoked_by   uuid REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX pipelines_by_workspace ON pipelines (workspace_id, created_at);

CREATE TABLE pipeline_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id  uuid NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sha256       bytea NOT NULL UNIQUE CHECK (octet_length(sha256) = 32),
  -- The key's last 4 characters, to tell keys apart in lists.
  hint         text NOT NULL CHECK (char_length(hint) = 4),
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at   timestamptz,
  revoked_by   uuid REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX pipeline_keys_by_pipeline ON pipeline_keys (pipeline_id, created_at);

-- A pipeline's writes, proposals and audit entries are its own: credited to
-- the pipeline, for its owner (actor_id, author_id).
ALTER TABLE audit_log DROP CONSTRAINT audit_log_actor_type_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_actor_type_check
  CHECK (actor_type IN ('user', 'agent', 'pipeline'));
ALTER TABLE file_versions DROP CONSTRAINT file_versions_author_type_check;
ALTER TABLE file_versions ADD CONSTRAINT file_versions_author_type_check
  CHECK (author_type IN ('user', 'agent', 'pipeline'));
ALTER TABLE proposals DROP CONSTRAINT proposals_author_type_check;
ALTER TABLE proposals ADD CONSTRAINT proposals_author_type_check
  CHECK (author_type IN ('user', 'agent', 'pipeline'));
