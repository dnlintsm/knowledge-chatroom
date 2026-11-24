-- Recovering a deleted experiment (docs/run-evidence.md, "Recovering a deleted
-- Experiment"). A delete stays a soft delete; this makes it undoable.
--
-- Row-level security hides a deleted experiment from everyone
-- (experiment_access needs a live one), and that stays so: the list and the
-- restore below are functions that check who may see and restore it, so no
-- other query starts seeing deleted rows.

-- Who deleted it, for the "Recently deleted" list. Earlier deletes take it
-- from the audit log; an experiment deleted with its node has none.
ALTER TABLE experiments ADD COLUMN deleted_by uuid REFERENCES users(id) ON DELETE SET NULL;

UPDATE experiments e SET deleted_by = a.actor_id
FROM (
  SELECT DISTINCT ON (workspace_id, target->>'experiment')
         workspace_id, target->>'experiment' AS experiment, actor_id
  FROM audit_log
  WHERE action = 'experiment.delete'
  ORDER BY workspace_id, target->>'experiment', at DESC, id DESC
) a
WHERE e.deleted_at IS NOT NULL AND a.workspace_id = e.workspace_id AND a.experiment = e.id::text;

-- Whether `uid` may see and restore this deleted experiment: its maintainer,
-- or an Owner or Admin for one that isn't a draft (as for a handover), and
-- either way a member who can view its node. A draft whose maintainer left
-- stays deleted.
CREATE FUNCTION experiment_restorer(uid uuid, exp uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
  SELECT EXISTS (
    SELECT 1 FROM experiments e
    WHERE e.id = exp AND e.deleted_at IS NOT NULL
      AND workspace_member(e.workspace_id, uid)
      AND effective_role(e.workspace_id, uid, e.node_id) IS NOT NULL
      AND (e.maintainer_id = uid
           OR (e.status <> 'draft' AND workspace_manager(e.workspace_id, uid))))
$$;

-- The deleted experiments of a workspace that `uid` may restore, newest
-- deletion first, with what an experiment's answer shows. `file_count` is the
-- files that a restore brings back; `node_live` says whether it can be.
CREATE FUNCTION deleted_experiments(ws uuid, uid uuid)
  RETURNS TABLE (
    id uuid, node_id uuid, author_id uuid, title text, hypothesis text, params jsonb,
    results jsonb, status text, state text, forked_at timestamptz, updated_at timestamptz,
    provenance jsonb, file_count bigint, maintainer_id uuid, maintainer_is_member boolean,
    collaborators jsonb, deleted_at timestamptz, deleted_by uuid, node_live boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
  SELECT e.id, e.node_id, e.author_id, e.title, e.hypothesis, e.params, e.results, e.status,
         e.state, e.forked_at, e.updated_at, e.provenance,
         (SELECT count(*) FROM files f WHERE f.experiment_id = e.id AND f.deleted_at = e.deleted_at),
         e.maintainer_id, workspace_member(e.workspace_id, e.maintainer_id),
         (SELECT coalesce(jsonb_agg(jsonb_build_object('id', c.user_id, 'name', cu.name)
                                    ORDER BY lower(coalesce(cu.name, cu.email, '')), c.created_at), '[]')
          FROM experiment_collaborators c JOIN users cu ON cu.id = c.user_id
          WHERE c.experiment_id = e.id),
         e.deleted_at, e.deleted_by,
         e.node_id IS NULL OR EXISTS (SELECT 1 FROM nodes n WHERE n.id = e.node_id AND n.deleted_at IS NULL)
  FROM experiments e
  WHERE e.workspace_id = ws AND e.deleted_at IS NOT NULL AND experiment_restorer(uid, e.id)
  ORDER BY e.deleted_at DESC, e.id
$$;

-- Restores it for `uid`, if they may: clears deleted_at, and the files go
-- with it (the trigger below). If its maintainer is no longer a member, `uid`
-- (then an Owner or Admin) becomes its maintainer, as a handover would make
-- them. Answers 'restored', with `handed_from` set to the departed maintainer
-- when it went to `uid`; 'node_deleted' when its node is gone (restoring nodes
-- is out of scope); or no row when it isn't there for `uid` (gone, live, or
-- not theirs to restore).
CREATE FUNCTION restore_experiment(ws uuid, uid uuid, exp uuid)
  RETURNS TABLE (outcome text, handed_from uuid, node_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  e experiments%ROWTYPE;
  handed uuid;
BEGIN
  SELECT * INTO e FROM experiments x WHERE x.id = exp AND x.workspace_id = ws FOR UPDATE;
  IF NOT FOUND OR e.deleted_at IS NULL OR NOT experiment_restorer(uid, exp) THEN
    RETURN;
  END IF;
  -- Held until commit, so the node can't be deleted under the restore.
  IF e.node_id IS NOT NULL THEN
    PERFORM 1 FROM nodes n WHERE n.id = e.node_id AND n.deleted_at IS NULL FOR SHARE;
    IF NOT FOUND THEN
      RETURN QUERY SELECT 'node_deleted'::text, NULL::uuid, e.node_id;
      RETURN;
    END IF;
  END IF;
  IF NOT workspace_member(ws, e.maintainer_id) THEN
    DELETE FROM experiment_collaborators c WHERE c.experiment_id = exp AND c.user_id = uid;
    UPDATE experiments SET maintainer_id = uid WHERE id = exp;
    handed := e.maintainer_id;
  END IF;
  UPDATE experiments SET deleted_at = NULL, deleted_by = NULL, updated_at = now() WHERE id = exp;
  RETURN QUERY SELECT 'restored'::text, handed, e.node_id;
END $$;

-- A restored experiment's files come back: those deleted with it, whose
-- deleted_at is the experiment's. Files deleted before it stay deleted.
CREATE FUNCTION experiments_restore_files() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
BEGIN
  UPDATE files SET deleted_at = NULL
  WHERE experiment_id = NEW.id AND deleted_at = OLD.deleted_at;
  RETURN NULL;
END $$;

CREATE TRIGGER experiments_restore_files AFTER UPDATE OF deleted_at ON experiments
  FOR EACH ROW WHEN (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL)
  EXECUTE FUNCTION experiments_restore_files();
