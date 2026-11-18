-- Personalized memory (issue #93, step 1): short markdown notes Claude keeps
-- about each user across chats, read through an index in its prompt and the
-- memory tools (storage/memory.ts). A user's notes are theirs alone: nobody
-- else reads them, workspace owners included.

CREATE TABLE memories (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  -- One line for the index Claude sees in every chat.
  description  text NOT NULL CHECK (length(description) BETWEEN 1 AND 300),
  type         text NOT NULL CHECK (type IN ('preference', 'profile', 'project', 'reference', 'feedback')),
  body         text NOT NULL CHECK (length(body) <= 16000),
  version      integer NOT NULL DEFAULT 1,
  created_by   text NOT NULL CHECK (created_by IN ('user', 'agent')),
  updated_by   text NOT NULL CHECK (updated_by IN ('user', 'agent')),
  -- Claude's deletes archive the note, so they can be undone; the user's
  -- own delete removes it for good, with its versions.
  archived_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  UNIQUE (workspace_id, user_id, name)
);

-- Every version of a note, the current one included.
CREATE TABLE memory_versions (
  memory_id   uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  version     integer NOT NULL,
  description text NOT NULL,
  type        text NOT NULL,
  body        text NOT NULL,
  changed_by  text NOT NULL CHECK (changed_by IN ('user', 'agent')),
  -- The chat Claude changed it in.
  thread_id   text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (memory_id, version)
);

-- What Claude read and changed in which run: the chat's "Used / Updated"
-- line, and Undo for its changes.
CREATE TABLE memory_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  memory_id    uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  thread_id    text NOT NULL,
  run_id       text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('read', 'create', 'update', 'archive')),
  -- The note's version after a change (or the one read).
  version      integer NOT NULL,
  undone_at    timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX memory_events_by_user ON memory_events (user_id, created_at DESC);

-- Memory on or off for a user (no row: on), and chats kept out of it.
CREATE TABLE memory_settings (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode         text NOT NULL CHECK (mode IN ('on', 'off')),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

-- Incognito chats: Claude neither reads nor writes memory in them.
CREATE TABLE memory_incognito_chats (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id    text NOT NULL CHECK (length(thread_id) BETWEEN 1 AND 200),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id, thread_id)
);

ALTER TABLE memories ENABLE ROW LEVEL SECURITY;
CREATE POLICY memories_own ON memories
  USING (user_id = app_user()) WITH CHECK (user_id = app_user());

ALTER TABLE memory_versions ENABLE ROW LEVEL SECURITY;
-- The subqueries see memories through memories' own policy.
CREATE POLICY memory_versions_own ON memory_versions
  USING (EXISTS (SELECT 1 FROM memories m WHERE m.id = memory_id))
  WITH CHECK (EXISTS (SELECT 1 FROM memories m WHERE m.id = memory_id));

ALTER TABLE memory_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY memory_events_own ON memory_events
  USING (user_id = app_user()) WITH CHECK (user_id = app_user());

ALTER TABLE memory_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY memory_settings_own ON memory_settings
  USING (user_id = app_user()) WITH CHECK (user_id = app_user());

ALTER TABLE memory_incognito_chats ENABLE ROW LEVEL SECURITY;
CREATE POLICY memory_incognito_chats_own ON memory_incognito_chats
  USING (user_id = app_user()) WITH CHECK (user_id = app_user());
