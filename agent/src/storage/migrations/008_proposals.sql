-- Proposed versions (issue #4, step 7): a change to a file in a knowledge
-- node (or at the workspace root) that waits for someone who can edit there
-- to accept or reject it. Claude's edits to a node arrive this way, and so
-- does an experiment's work when its author promotes it to the node. The
-- proposed bytes are a blob like any version's; accepting writes them as the
-- file's next version, credited to whoever proposed them.

CREATE TABLE proposals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- The file it would change: a node's, or the root's (node_id NULL).
  node_id       uuid REFERENCES nodes(id),
  path          text NOT NULL CHECK (path <> '' AND path !~ '^/' AND path !~ '//'),
  -- The file's version when this was proposed; NULL for a new file.
  base_version_id uuid REFERENCES file_versions(id),
  blob_sha256   text NOT NULL REFERENCES blobs(sha256),
  size          bigint NOT NULL CHECK (size >= 0),
  mime          text NOT NULL,
  author_type   text NOT NULL CHECK (author_type IN ('user', 'agent')),
  -- The user, or the user Claude was acting for.
  author_id     uuid NOT NULL REFERENCES users(id),
  -- Set when it comes from an experiment's file (promotion).
  experiment_id uuid REFERENCES experiments(id),
  note          text NOT NULL DEFAULT '' CHECK (length(note) <= 2000),
  status        text NOT NULL DEFAULT 'open'
                CHECK (status IN ('open', 'accepted', 'rejected', 'withdrawn')),
  decided_by    uuid REFERENCES users(id),
  decided_at    timestamptz,
  -- The file's version once it was accepted.
  version_id    uuid REFERENCES file_versions(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- One open proposal per file and proposer: proposing again replaces it.
CREATE UNIQUE INDEX proposals_open_one ON proposals (workspace_id, node_id, path, author_type, author_id)
  NULLS NOT DISTINCT WHERE status = 'open';
CREATE INDEX proposals_open_by_node ON proposals (workspace_id, node_id) WHERE status = 'open';
CREATE INDEX proposals_by_experiment ON proposals (experiment_id) WHERE experiment_id IS NOT NULL;

-- Row-level security (see 004_row_security.sql): whoever can read the place
-- sees its proposals, and their own anywhere; anyone who can read a place may
-- propose there; editors decide, and proposers may withdraw their own.
ALTER TABLE proposals ENABLE ROW LEVEL SECURITY;
CREATE POLICY proposals_read ON proposals FOR SELECT
  USING (author_id = app_user() OR place_rank(workspace_id, app_user(), node_id, NULL) >= 1);
CREATE POLICY proposals_add ON proposals FOR INSERT
  WITH CHECK (author_id = app_user() AND place_rank(workspace_id, app_user(), node_id, NULL) >= 1);
CREATE POLICY proposals_change ON proposals FOR UPDATE
  USING (author_id = app_user() OR place_rank(workspace_id, app_user(), node_id, NULL) >= 2)
  WITH CHECK (place_rank(workspace_id, app_user(), node_id, NULL) >= 2
              OR (author_id = app_user() AND status IN ('open', 'withdrawn')));
