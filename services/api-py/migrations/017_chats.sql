-- Chat history (issue #91): each AG-UI thread the app's chat runs is a chat,
-- owned by the one user who started it, so it survives restarts and shows in
-- that user's history only. Nobody else reads it, workspace owners included.

CREATE TABLE chats (
  -- The thread id the browser chose (CopilotKit makes a random UUID).
  id           text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  user_id      uuid NOT NULL REFERENCES users(id),
  agent_id     text NOT NULL,
  -- The first thing the user asked, until they rename it.
  name         text,
  archived     boolean NOT NULL DEFAULT false,
  -- The conversation as of the latest run (AG-UI messages), for the
  -- history's messages route and for anything that reads past chats.
  messages     jsonb NOT NULL DEFAULT '[]',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  last_run_at  timestamptz
);
CREATE INDEX chats_by_user ON chats (user_id, agent_id, updated_at DESC, id);

-- Each finished run's AG-UI events (compacted), replayed in order when the
-- chat is opened again.
CREATE TABLE chat_runs (
  chat_id       text NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  seq           integer NOT NULL,
  run_id        text NOT NULL,
  parent_run_id text,
  events        jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chat_id, seq)
);

ALTER TABLE chats ENABLE ROW LEVEL SECURITY;
CREATE POLICY chats_own ON chats
  USING (user_id = app_user())
  WITH CHECK (user_id = app_user());

ALTER TABLE chat_runs ENABLE ROW LEVEL SECURITY;
-- The subqueries see chats through chats' own policy.
CREATE POLICY chat_runs_own ON chat_runs
  USING (EXISTS (SELECT 1 FROM chats c WHERE c.id = chat_id))
  WITH CHECK (EXISTS (SELECT 1 FROM chats c WHERE c.id = chat_id));
