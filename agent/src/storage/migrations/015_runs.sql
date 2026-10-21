-- Runs are experiments (issue #82): an experiment with a report.md is a run,
-- replacing the old run folders. Two changes make that work:
--
-- - An experiment may sit at the workspace root (node_id NULL), so a first
--   upload can become a run before anyone sets up the knowledge tree. Who may
--   see or start one there follows the root's role, as for the root's files.
-- - `state` says how far a run got (ready, running, done, failed), apart
--   from `status`, which says who sees it (draft, shared, archived).

ALTER TABLE experiments ALTER COLUMN node_id DROP NOT NULL;
ALTER TABLE experiments ADD COLUMN state text NOT NULL DEFAULT 'ready'
  CHECK (state IN ('ready', 'running', 'done', 'failed'));

CREATE OR REPLACE FUNCTION experiments_place() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW.node_id IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM 1 FROM nodes
  WHERE id = NEW.node_id AND workspace_id = NEW.workspace_id AND deleted_at IS NULL
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Node not found';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION experiment_access(uid uuid, exp uuid) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
  SELECT CASE
    WHEN effective_role(e.workspace_id, uid, e.node_id) IS NULL THEN NULL
    WHEN e.author_id = uid AND e.status <> 'archived' THEN 'writer'
    WHEN e.author_id = uid OR e.status <> 'draft' THEN 'reader'
  END
  FROM experiments e LEFT JOIN nodes n ON n.id = e.node_id
  WHERE e.id = exp AND e.deleted_at IS NULL
    AND (e.node_id IS NULL OR n.deleted_at IS NULL)
$$;
