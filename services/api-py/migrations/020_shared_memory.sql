-- Shared memory (issue #93, step 3): notes for a whole workspace, a knowledge
-- node (and everything below it) or a group of people (and its sub-groups).
-- Who can read and change them follows the grants: see shared_memory_rank.
-- Claude never changes them itself: its changes are proposals that someone
-- who can edit the note's place accepts or rejects. A person shares one of
-- their own notes by copying it in (a snapshot, not a link).

-- 0: none; 1: reads it; 2: edits it and decides proposals.
--   workspace: anyone with a grant in the workspace reads; editors of the
--              workspace root edit.
--   node:      readers of the node read; its editors edit.
--   group:     members (of it or a sub-group) read and edit; so do workspace
--              owners, who manage groups.
CREATE FUNCTION shared_memory_rank(ws uuid, uid uuid, scope text, node uuid, grp uuid) RETURNS int
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
  SELECT CASE scope
    WHEN 'workspace' THEN CASE
      WHEN place_rank(ws, uid, NULL, NULL) >= 2 THEN 2
      WHEN EXISTS (SELECT 1 FROM grants g WHERE g.workspace_id = ws
                   AND grant_holder(uid, g.principal_type, g.principal_id)) THEN 1
      ELSE 0 END
    WHEN 'node' THEN place_rank(ws, uid, node, NULL)
    WHEN 'group' THEN CASE
      WHEN grant_holder(uid, 'group', grp) OR role_rank(effective_role(ws, uid, NULL)) >= 3 THEN 2
      ELSE 0 END
    ELSE 0 END
$$;

CREATE TABLE shared_memories (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scope        text NOT NULL CHECK (scope IN ('workspace', 'node', 'group')),
  node_id      uuid REFERENCES nodes(id) ON DELETE CASCADE,
  group_id     uuid REFERENCES groups(id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  description  text NOT NULL CHECK (length(description) BETWEEN 1 AND 300),
  type         text NOT NULL CHECK (type IN ('preference', 'profile', 'project', 'reference', 'feedback')),
  body         text NOT NULL DEFAULT '' CHECK (length(body) <= 16000),
  version      integer NOT NULL DEFAULT 1,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'workspace' AND node_id IS NULL AND group_id IS NULL)
      OR (scope = 'node' AND node_id IS NOT NULL AND group_id IS NULL)
      OR (scope = 'group' AND group_id IS NOT NULL AND node_id IS NULL))
);
CREATE UNIQUE INDEX shared_memories_name
  ON shared_memories (workspace_id, scope, node_id, group_id, name) NULLS NOT DISTINCT;

CREATE TABLE shared_memory_versions (
  memory_id   uuid NOT NULL REFERENCES shared_memories(id) ON DELETE CASCADE,
  version     integer NOT NULL,
  description text NOT NULL,
  type        text NOT NULL,
  body        text NOT NULL,
  -- Who made it; for an accepted proposal, its author.
  changed_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  -- agent: Claude proposed it (for changed_by) and someone accepted it.
  changed_as  text NOT NULL CHECK (changed_as IN ('user', 'agent')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (memory_id, version)
);

-- A change waiting for someone who can edit the place: Claude's, or a copy a
-- person shared to a place they can't edit themselves.
CREATE TABLE shared_memory_proposals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scope        text NOT NULL CHECK (scope IN ('workspace', 'node', 'group')),
  node_id      uuid REFERENCES nodes(id) ON DELETE CASCADE,
  group_id     uuid REFERENCES groups(id) ON DELETE CASCADE,
  -- The note it changes (update, delete); NULL for a new note.
  memory_id    uuid REFERENCES shared_memories(id) ON DELETE CASCADE,
  op           text NOT NULL CHECK (op IN ('add', 'update', 'delete')),
  name         text NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  description  text CHECK (length(description) <= 300),
  type         text CHECK (type IN ('preference', 'profile', 'project', 'reference', 'feedback')),
  body         text CHECK (length(body) <= 16000),
  base_version integer,
  author_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  author_type  text NOT NULL CHECK (author_type IN ('user', 'agent')),
  thread_id    text,
  reason       text CHECK (length(reason) <= 500),
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'rejected', 'withdrawn')),
  decided_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shared_memory_proposals_open ON shared_memory_proposals (workspace_id, created_at) WHERE status = 'open';

-- Auto (in every chat's memory index), Manual (only found by searching) or
-- Off: for everyone (user_id NULL, set by its editors) and per person.
CREATE TABLE shared_memory_settings (
  memory_id  uuid NOT NULL REFERENCES shared_memories(id) ON DELETE CASCADE,
  user_id    uuid REFERENCES users(id) ON DELETE CASCADE,
  mode       text NOT NULL CHECK (mode IN ('auto', 'manual', 'off')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX shared_memory_settings_one ON shared_memory_settings (memory_id, user_id) NULLS NOT DISTINCT;

ALTER TABLE shared_memories ENABLE ROW LEVEL SECURITY;
CREATE POLICY shared_memories_read ON shared_memories FOR SELECT
  USING (shared_memory_rank(workspace_id, app_user(), scope, node_id, group_id) >= 1);
CREATE POLICY shared_memories_add ON shared_memories FOR INSERT
  WITH CHECK (shared_memory_rank(workspace_id, app_user(), scope, node_id, group_id) >= 2);
CREATE POLICY shared_memories_change ON shared_memories FOR UPDATE
  USING (shared_memory_rank(workspace_id, app_user(), scope, node_id, group_id) >= 2);
CREATE POLICY shared_memories_remove ON shared_memories FOR DELETE
  USING (shared_memory_rank(workspace_id, app_user(), scope, node_id, group_id) >= 2);

ALTER TABLE shared_memory_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY shared_memory_versions_read ON shared_memory_versions FOR SELECT
  USING (EXISTS (SELECT 1 FROM shared_memories m WHERE m.id = memory_id));
CREATE POLICY shared_memory_versions_add ON shared_memory_versions FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM shared_memories m WHERE m.id = memory_id
    AND shared_memory_rank(m.workspace_id, app_user(), m.scope, m.node_id, m.group_id) >= 2));

-- Their author and the place's editors see a proposal; anyone who reads the
-- place may propose there; editors decide, and authors may withdraw.
ALTER TABLE shared_memory_proposals ENABLE ROW LEVEL SECURITY;
CREATE POLICY shared_memory_proposals_read ON shared_memory_proposals FOR SELECT
  USING (author_id = app_user() OR shared_memory_rank(workspace_id, app_user(), scope, node_id, group_id) >= 2);
CREATE POLICY shared_memory_proposals_add ON shared_memory_proposals FOR INSERT
  WITH CHECK (author_id = app_user() AND shared_memory_rank(workspace_id, app_user(), scope, node_id, group_id) >= 1);
CREATE POLICY shared_memory_proposals_change ON shared_memory_proposals FOR UPDATE
  USING (author_id = app_user() OR shared_memory_rank(workspace_id, app_user(), scope, node_id, group_id) >= 2)
  WITH CHECK (shared_memory_rank(workspace_id, app_user(), scope, node_id, group_id) >= 2
              OR (author_id = app_user() AND status IN ('open', 'withdrawn')));

-- Everyone's mode is its editors'; your own is yours.
ALTER TABLE shared_memory_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY shared_memory_settings_read ON shared_memory_settings FOR SELECT
  USING (user_id IS NULL OR user_id = app_user());
CREATE POLICY shared_memory_settings_own ON shared_memory_settings FOR ALL
  USING (user_id = app_user()) WITH CHECK (user_id = app_user()
    AND EXISTS (SELECT 1 FROM shared_memories m WHERE m.id = memory_id));
CREATE POLICY shared_memory_settings_everyone ON shared_memory_settings FOR ALL
  USING (user_id IS NULL AND EXISTS (SELECT 1 FROM shared_memories m WHERE m.id = memory_id
    AND shared_memory_rank(m.workspace_id, app_user(), m.scope, m.node_id, m.group_id) >= 2))
  WITH CHECK (user_id IS NULL AND EXISTS (SELECT 1 FROM shared_memories m WHERE m.id = memory_id
    AND shared_memory_rank(m.workspace_id, app_user(), m.scope, m.node_id, m.group_id) >= 2));
