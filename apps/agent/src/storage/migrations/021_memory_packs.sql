-- Memory packs and import (issue #93, step 4).
--
-- A memory pack is a place's shared notes published to the hub (one per
-- deployment, like skills: 011_skill_hub.sql) as immutable versions. Whoever
-- publishes a name first owns it there. A place's editors install a pack
-- pinned to a version: its notes become that place's shared notes, read-only
-- and Manual for everyone until someone turns them on. Forking turns them
-- into the place's own notes.

CREATE TABLE hub_memory_packs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE CHECK (name ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  owner_id    uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hub_memory_pack_versions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id       uuid NOT NULL REFERENCES hub_memory_packs(id) ON DELETE CASCADE,
  version       integer NOT NULL CHECK (version > 0),
  description   text NOT NULL CHECK (length(description) BETWEEN 1 AND 300),
  -- [{name, description, type, body}]: the notes, in name order.
  notes         jsonb NOT NULL,
  -- Identifies the notes, so publishing them unchanged adds no version.
  fingerprint   text NOT NULL,
  -- [{kind, path, line, detail}], as skills' scan.ts finds them.
  flags         jsonb NOT NULL DEFAULT '[]',
  published_by  uuid NOT NULL REFERENCES users(id),
  published_at  timestamptz NOT NULL DEFAULT now(),
  verified_at   timestamptz,
  verified_by   uuid REFERENCES users(id),
  -- A yanked version can't be newly installed; installs of it keep working.
  yanked_at     timestamptz,
  yanked_by     uuid REFERENCES users(id),
  yank_reason   text CHECK (length(yank_reason) <= 500),
  UNIQUE (pack_id, version)
);

CREATE TABLE memory_pack_installs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scope        text NOT NULL CHECK (scope IN ('workspace', 'node', 'group')),
  node_id      uuid REFERENCES nodes(id) ON DELETE CASCADE,
  group_id     uuid REFERENCES groups(id) ON DELETE CASCADE,
  pack_id      uuid NOT NULL REFERENCES hub_memory_packs(id) ON DELETE CASCADE,
  version_id   uuid NOT NULL REFERENCES hub_memory_pack_versions(id),
  installed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  installed_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX memory_pack_installs_one
  ON memory_pack_installs (workspace_id, scope, node_id, group_id, pack_id) NULLS NOT DISTINCT;

-- A pack's notes in a place; they go with the install.
ALTER TABLE shared_memories
  ADD COLUMN pack_install_id uuid REFERENCES memory_pack_installs(id) ON DELETE CASCADE;

-- import: notes from another assistant's memory or a file, for review.
ALTER TABLE memory_inbox DROP CONSTRAINT memory_inbox_source_check;
ALTER TABLE memory_inbox ADD CONSTRAINT memory_inbox_source_check CHECK (source IN ('chat', 'learn', 'import'));
