-- Personalized memory, step 2 (issue #93): Claude learns from chats once they
-- go quiet, and changes can wait in an inbox for the user to review.

-- "ask": Claude's changes, in chats and from past chats, wait in the inbox.
ALTER TABLE memory_settings DROP CONSTRAINT memory_settings_mode_check;
ALTER TABLE memory_settings ADD CONSTRAINT memory_settings_mode_check CHECK (mode IN ('on', 'ask', 'off'));

-- Changes Claude proposes, for the user to accept or reject.
CREATE TABLE memory_inbox (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  op           text NOT NULL CHECK (op IN ('add', 'update', 'delete')),
  name         text NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  description  text CHECK (length(description) <= 300),
  type         text CHECK (type IN ('preference', 'profile', 'project', 'reference', 'feedback')),
  body         text CHECK (length(body) <= 16000),
  -- The note's version the change was made against (update, delete).
  base_version integer,
  -- chat: Claude in a chat (memory set to ask, or the turn read outside
  -- content); learn: from a past chat, in the background.
  source       text NOT NULL CHECK (source IN ('chat', 'learn')),
  thread_id    text,
  reason       text CHECK (length(reason) <= 500),
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  decided_at   timestamptz
);
CREATE INDEX memory_inbox_pending ON memory_inbox (user_id, created_at) WHERE status = 'pending';

-- How far each chat has been learned from: up to its run at `through`.
CREATE TABLE memory_learned_chats (
  chat_id      text PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  through      timestamptz NOT NULL,
  -- Set when the last try failed (it isn't retried until the chat moves on).
  error        text,
  learned_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE memory_inbox ENABLE ROW LEVEL SECURITY;
CREATE POLICY memory_inbox_own ON memory_inbox
  USING (user_id = app_user()) WITH CHECK (user_id = app_user());

ALTER TABLE memory_learned_chats ENABLE ROW LEVEL SECURITY;
CREATE POLICY memory_learned_chats_own ON memory_learned_chats
  USING (user_id = app_user()) WITH CHECK (user_id = app_user());
