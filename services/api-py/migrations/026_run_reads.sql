-- Which versions of a run's own recorded files (its generated Rules,
-- models/general_rules.md) an agent or tool read while the run was running,
-- so the run can say which Rules it read rather than which were there at the
-- end (docs/run-evidence.md). One row per run, path and version: the first
-- read of it. Only a maintainer's or collaborator's agent records one, through
-- a storage token; a person viewing the file isn't the run reading it.

CREATE TABLE run_reads (
  workspace_id  uuid NOT NULL REFERENCES workspaces(id),
  experiment_id uuid NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  path          text NOT NULL,
  version_id    uuid NOT NULL REFERENCES file_versions(id) ON DELETE CASCADE,
  sha256        text NOT NULL,
  user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  -- The storage token's `via`: "remote" for Claude in the chat, "mcp:<name>"
  -- for a tool server.
  via           text NOT NULL,
  first_read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (experiment_id, path, version_id)
);

-- Row-level security (see 004_row_security.sql): whoever can see the run sees
-- what it read; only someone who works on it records a read, as themselves.
ALTER TABLE run_reads ENABLE ROW LEVEL SECURITY;
CREATE POLICY run_reads_read ON run_reads FOR SELECT
  USING (experiment_access(app_user(), experiment_id) IS NOT NULL);
CREATE POLICY run_reads_add ON run_reads FOR INSERT
  WITH CHECK (user_id = app_user() AND experiment_access(app_user(), experiment_id) = 'writer');
-- knowledge_user gets SELECT and INSERT on run_reads at startup, with its
-- other grants (prepare_row_security in api-py).
