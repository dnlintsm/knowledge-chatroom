-- Experiments (issue #4, step 5): a user's sandbox on one knowledge node,
-- usually a process. Forking gives the experiment its own copy of the node's
-- file list, pointing at the same stored bytes, and from then on every write,
-- by the user or by Claude, lands in the experiment, never in the node.
--
-- Who sees one: a draft only its author; shared and archived ones anyone who
-- can view the node. Only the author changes it, and only while it isn't
-- archived; the author also needs some role on the node, so taking someone's
-- access away takes their experiments there with it.

CREATE TABLE experiments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  node_id      uuid NOT NULL REFERENCES nodes(id),
  author_id    uuid NOT NULL REFERENCES users(id),
  title        text NOT NULL CHECK (btrim(title) <> '' AND length(title) <= 200),
  hypothesis   text NOT NULL DEFAULT '' CHECK (length(hypothesis) <= 20000),
  -- What was tried and what came out, as flat or nested JSON objects, so the
  -- experiments on one node can be compared side by side.
  params       jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(params) = 'object'),
  results      jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(results) = 'object'),
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'shared', 'archived')),
  -- When the node's files were copied in.
  forked_at    timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);

CREATE INDEX experiments_by_node ON experiments (node_id) WHERE deleted_at IS NULL;

-- A file belongs to the workspace root, a node, or an experiment.
ALTER TABLE files ADD COLUMN experiment_id uuid REFERENCES experiments(id);
ALTER TABLE files ADD CONSTRAINT files_one_place CHECK (node_id IS NULL OR experiment_id IS NULL);
-- For a forked file, the node's version it started from (proposals diff against it).
ALTER TABLE files ADD COLUMN forked_from uuid REFERENCES file_versions(id);
DROP INDEX files_live_path;
CREATE UNIQUE INDEX files_live_path ON files (workspace_id, node_id, experiment_id, path)
  NULLS NOT DISTINCT WHERE deleted_at IS NULL;
CREATE INDEX files_by_experiment ON files (experiment_id) WHERE deleted_at IS NULL;

-- What `uid` may do in an experiment: 'writer' (its author, while it isn't
-- archived), 'reader', or NULL for nothing.
CREATE FUNCTION experiment_access(uid uuid, exp uuid) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
  SELECT CASE
    WHEN effective_role(e.workspace_id, uid, e.node_id) IS NULL THEN NULL
    WHEN e.author_id = uid AND e.status <> 'archived' THEN 'writer'
    WHEN e.author_id = uid OR e.status <> 'draft' THEN 'reader'
  END
  FROM experiments e JOIN nodes n ON n.id = e.node_id
  WHERE e.id = exp AND e.deleted_at IS NULL AND n.deleted_at IS NULL
$$;

-- Read (1) or write (2) access to a place's files: a node or the root by
-- role, an experiment by experiment_access. 0 for none.
CREATE FUNCTION place_rank(ws uuid, uid uuid, node uuid, exp uuid) RETURNS int
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
  SELECT CASE
    WHEN exp IS NULL THEN least(role_rank(effective_role(ws, uid, node)), 2)
    ELSE CASE experiment_access(uid, exp) WHEN 'writer' THEN 2 WHEN 'reader' THEN 1 ELSE 0 END
  END
$$;

-- Deleting an experiment takes its files; deleting a node takes the
-- experiments on it. These run with the owner's rights, since the person
-- deleting can't always see or change those rows themselves (other people's
-- drafts, an archived experiment's files).
CREATE FUNCTION experiments_drop_files() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
BEGIN
  UPDATE files SET deleted_at = NEW.deleted_at
  WHERE experiment_id = NEW.id AND deleted_at IS NULL;
  RETURN NULL;
END $$;

CREATE TRIGGER experiments_drop_files AFTER UPDATE OF deleted_at ON experiments
  FOR EACH ROW WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
  EXECUTE FUNCTION experiments_drop_files();

CREATE FUNCTION nodes_drop_experiments() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
BEGIN
  UPDATE experiments SET deleted_at = NEW.deleted_at
  WHERE node_id = NEW.id AND deleted_at IS NULL;
  RETURN NULL;
END $$;

CREATE TRIGGER nodes_drop_experiments AFTER UPDATE OF deleted_at ON nodes
  FOR EACH ROW WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
  EXECUTE FUNCTION nodes_drop_experiments();

-- Row-level security (see 004_row_security.sql), now aware of experiments.
ALTER TABLE experiments ENABLE ROW LEVEL SECURITY;
CREATE POLICY experiments_read ON experiments FOR SELECT
  USING (experiment_access(app_user(), id) IS NOT NULL);
CREATE POLICY experiments_add ON experiments FOR INSERT
  WITH CHECK (author_id = app_user()
              AND effective_role(workspace_id, app_user(), node_id) IS NOT NULL);
-- Status and content checks (archived is read only) are the app's; here, the
-- author keeps it and nobody else changes it.
CREATE POLICY experiments_change ON experiments FOR UPDATE
  USING (author_id = app_user() AND experiment_access(app_user(), id) IS NOT NULL)
  WITH CHECK (author_id = app_user());

DROP POLICY files_read ON files;
DROP POLICY files_add ON files;
DROP POLICY files_change ON files;
CREATE POLICY files_read ON files FOR SELECT
  USING (place_rank(workspace_id, app_user(), node_id, experiment_id) >= 1);
CREATE POLICY files_add ON files FOR INSERT
  WITH CHECK (place_rank(workspace_id, app_user(), node_id, experiment_id) >= 2);
CREATE POLICY files_change ON files FOR UPDATE
  USING (place_rank(workspace_id, app_user(), node_id, experiment_id) >= 2)
  WITH CHECK (place_rank(workspace_id, app_user(), node_id, experiment_id) >= 2);

DROP POLICY file_versions_add ON file_versions;
CREATE POLICY file_versions_add ON file_versions FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM files f
    WHERE f.id = file_id
      AND place_rank(f.workspace_id, app_user(), f.node_id, f.experiment_id) >= 2));
