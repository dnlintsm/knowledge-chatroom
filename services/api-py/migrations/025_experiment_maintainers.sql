-- Experiment handover (issue #255, docs/workspaces.md, "Experiment handover").
-- An experiment keeps its author, who created it, as provenance that never
-- changes. Its maintainer is who is responsible for it now: the author until
-- they hand it over. Collaborators are members the maintainer adds to work on
-- it with them. Maintainer and collaborators both edit it while it isn't
-- archived and see it while it is a draft; only the maintainer changes its
-- visibility, deletes it or manages who works on it. Owners and Admins of the
-- workspace may hand over a shared or archived one, never a draft. Everyone
-- still needs a role on its node (or the root), as before.

ALTER TABLE experiments ADD COLUMN maintainer_id uuid REFERENCES users(id);
UPDATE experiments SET maintainer_id = author_id;
ALTER TABLE experiments ALTER COLUMN maintainer_id SET NOT NULL;

CREATE TABLE experiment_collaborators (
  experiment_id uuid NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (experiment_id, user_id)
);

CREATE INDEX experiment_collaborators_by_user ON experiment_collaborators (user_id);

-- Whether `uid` works on the experiment: its maintainer or a collaborator.
CREATE FUNCTION experiment_works(uid uuid, exp uuid, maintainer uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
  SELECT maintainer = uid
      OR EXISTS (SELECT 1 FROM experiment_collaborators c WHERE c.experiment_id = exp AND c.user_id = uid)
$$;

-- Whether `uid` is an Owner or Admin of the workspace.
CREATE FUNCTION workspace_manager(ws uuid, uid uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
  SELECT EXISTS (
    SELECT 1 FROM workspace_members
    WHERE workspace_id = ws AND user_id = uid AND role IN ('owner', 'admin'))
$$;

-- Whether `uid` is a member of the workspace (for an experiment's answer: is its
-- maintainer still one?), readable from a user's own queries.
CREATE FUNCTION workspace_member(ws uuid, uid uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
  SELECT EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ws AND user_id = uid)
$$;

-- Holds a member until the transaction ends, and says whether they are one. A
-- write that gives someone something in the workspace (a grant, a group
-- membership, a collaborator place, an experiment to maintain) takes it first, so
-- a removal either waits for that write and then deletes what it added, or goes
-- first and this finds no member. The locks come in the removal's order: the
-- workspace's row (FOR KEY SHARE, which the removal's FOR UPDATE waits for, while
-- writes don't wait for each other), then the member's (FOR SHARE). The other
-- order deadlocks with a removal, since the write's own rows take a key share on
-- the workspace's row later.
CREATE FUNCTION lock_workspace_member(ws uuid, uid uuid) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path FROM CURRENT AS $$
BEGIN
  PERFORM 1 FROM workspaces WHERE id = ws FOR KEY SHARE;
  PERFORM 1 FROM workspace_members WHERE workspace_id = ws AND user_id = uid FOR SHARE;
  RETURN FOUND;
END $$;

-- As in 015, with "maintainer or collaborator" where it said "author".
CREATE OR REPLACE FUNCTION experiment_access(uid uuid, exp uuid) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
  SELECT CASE
    WHEN effective_role(e.workspace_id, uid, e.node_id) IS NULL THEN NULL
    WHEN experiment_works(uid, e.id, e.maintainer_id) AND e.status <> 'archived' THEN 'writer'
    WHEN experiment_works(uid, e.id, e.maintainer_id) OR e.status <> 'draft' THEN 'reader'
  END
  FROM experiments e LEFT JOIN nodes n ON n.id = e.node_id
  WHERE e.id = exp AND e.deleted_at IS NULL
    AND (e.node_id IS NULL OR n.deleted_at IS NULL)
$$;

-- A new experiment's maintainer is its author, whatever the insert says.
CREATE FUNCTION experiments_maintainer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.maintainer_id := NEW.author_id;
  RETURN NEW;
END $$;

CREATE TRIGGER experiments_maintainer BEFORE INSERT ON experiments
  FOR EACH ROW EXECUTE FUNCTION experiments_maintainer();

-- Row-level security (004_row_security.sql), now aware of maintainers and
-- collaborators. The policy decides who may update a row at all; the trigger
-- below decides which columns, which a policy can't see.
DROP POLICY experiments_change ON experiments;
CREATE POLICY experiments_change ON experiments FOR UPDATE
  USING (experiment_access(app_user(), id) IS NOT NULL
         AND (experiment_works(app_user(), id, maintainer_id)
              OR (status <> 'draft' AND workspace_manager(workspace_id, app_user()))))
  -- Without this, USING would also check the new row, and a maintainer couldn't
  -- hand a draft over without staying on it. The trigger checks the columns.
  WITH CHECK (true);

-- For a user's own queries (app.user_id set): the author never changes; only
-- the maintainer changes the visibility or deletes; the maintainer hands over,
-- or an Owner or Admin for one that isn't a draft. System work is unaffected:
-- no app user, or the tables' owner (SECURITY DEFINER functions, such as
-- deleting a node's experiments with it, run as that owner).
CREATE FUNCTION experiments_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  uid uuid := app_user();
BEGIN
  IF uid IS NULL OR current_user <> 'knowledge_user' THEN
    RETURN NEW;
  END IF;
  IF NEW.author_id IS DISTINCT FROM OLD.author_id THEN
    RAISE EXCEPTION 'An experiment''s author never changes';
  END IF;
  IF (NEW.status IS DISTINCT FROM OLD.status OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at)
     AND OLD.maintainer_id <> uid THEN
    RAISE EXCEPTION 'Only the experiment''s maintainer can do this';
  END IF;
  IF NEW.maintainer_id IS DISTINCT FROM OLD.maintainer_id AND OLD.maintainer_id <> uid
     AND NOT (OLD.status <> 'draft' AND workspace_manager(OLD.workspace_id, uid)) THEN
    RAISE EXCEPTION 'Only the experiment''s maintainer can do this';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER experiments_guard BEFORE UPDATE ON experiments
  FOR EACH ROW EXECUTE FUNCTION experiments_guard();

ALTER TABLE experiment_collaborators ENABLE ROW LEVEL SECURITY;
CREATE POLICY experiment_collaborators_read ON experiment_collaborators FOR SELECT
  USING (experiment_access(app_user(), experiment_id) IS NOT NULL);
-- The maintainer adds people; at a handover, whoever hands over keeps the
-- previous maintainer on.
CREATE POLICY experiment_collaborators_add ON experiment_collaborators FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM experiments e
    WHERE e.id = experiment_id
      AND (e.maintainer_id = app_user()
           OR (e.status <> 'draft' AND workspace_manager(e.workspace_id, app_user())))));
-- The maintainer removes anyone; a collaborator removes themselves.
CREATE POLICY experiment_collaborators_remove ON experiment_collaborators FOR DELETE
  USING (user_id = app_user() OR EXISTS (
    SELECT 1 FROM experiments e
    WHERE e.id = experiment_id
      AND (e.maintainer_id = app_user()
           OR (e.status <> 'draft' AND workspace_manager(e.workspace_id, app_user())))));
-- knowledge_user gets SELECT, INSERT and DELETE on experiment_collaborators at
-- startup, with its other grants (prepare_row_security in api-py, db.ts).
