-- Skill modes at three levels (issue #7, step 2): for everyone (user_id
-- NULL, set by editors of the workspace root), per user, and per chat.
-- The most specific one applies.

ALTER TABLE skill_settings DROP CONSTRAINT skill_settings_pkey;
ALTER TABLE skill_settings ALTER COLUMN user_id DROP NOT NULL;
CREATE UNIQUE INDEX skill_settings_scope
  ON skill_settings (workspace_id, user_id, skill) NULLS NOT DISTINCT;

CREATE TABLE chat_skill_settings (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id    text NOT NULL CHECK (length(thread_id) BETWEEN 1 AND 200),
  skill        text NOT NULL CHECK (skill ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  mode         text NOT NULL CHECK (mode IN ('auto', 'manual', 'off')),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id, thread_id, skill)
);
