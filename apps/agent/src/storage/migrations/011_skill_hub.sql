-- The skill hub (issue #7, step 3): one per deployment. Publishing snapshots
-- a workspace skill as an immutable version whose files are blobs (by
-- content hash); a workspace installs a hub skill pinned to one version.
-- The agent server reads and writes these itself, for one user at a time.

CREATE TABLE hub_skills (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The skill's name; whoever publishes it first owns it on the hub.
  name        text NOT NULL UNIQUE CHECK (name ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  owner_id    uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hub_skill_versions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hub_skill_id  uuid NOT NULL REFERENCES hub_skills(id) ON DELETE CASCADE,
  version       integer NOT NULL CHECK (version > 0),
  -- Front matter and flags (description, argumentHint, modelInvocable, ...),
  -- so the hub lists versions without reading their files.
  manifest      jsonb NOT NULL,
  -- [{path, sha256, size}]: the skill folder's files, each a blob.
  files         jsonb NOT NULL,
  -- Identifies the file set, so publishing unchanged files adds no version.
  fingerprint   text NOT NULL,
  published_by  uuid NOT NULL REFERENCES users(id),
  published_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (hub_skill_id, version)
);

CREATE TABLE skill_installs (
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  hub_skill_id  uuid NOT NULL REFERENCES hub_skills(id) ON DELETE CASCADE,
  version_id    uuid NOT NULL REFERENCES hub_skill_versions(id),
  installed_by  uuid NOT NULL REFERENCES users(id),
  installed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, hub_skill_id)
);

ALTER TABLE skill_invocations DROP CONSTRAINT skill_invocations_source_check;
ALTER TABLE skill_invocations
  ADD CONSTRAINT skill_invocations_source_check CHECK (source IN ('builtin', 'workspace', 'hub'));
