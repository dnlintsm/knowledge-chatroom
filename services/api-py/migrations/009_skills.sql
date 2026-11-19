-- Skill management (issue #7, step 1). Skills themselves are files
-- (skills/<name>/SKILL.md) or ship with the agent; these tables hold who
-- turned which skill to which mode, and which skills each turn used.
-- The agent server reads and writes them itself, always for one user.

CREATE TABLE skill_settings (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  skill        text NOT NULL CHECK (skill ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  mode         text NOT NULL CHECK (mode IN ('auto', 'manual', 'off')),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id, skill)
);

CREATE TABLE skill_invocations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id    text NOT NULL,
  run_id       text NOT NULL,
  skill        text NOT NULL,
  source       text NOT NULL CHECK (source IN ('builtin', 'workspace')),
  -- slash: the user typed /name; model: Claude picked it.
  trigger      text NOT NULL CHECK (trigger IN ('slash', 'model')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX skill_invocations_by_thread ON skill_invocations (thread_id, created_at);
