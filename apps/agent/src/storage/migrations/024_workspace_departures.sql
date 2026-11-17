-- Workspace administration (issue #255, docs/workspaces.md, "Administration and
-- handover"). Removing a member, or leaving, records a departure. Until the
-- compatibility cut-off every signed-in user becomes a member of the default
-- workspace at sign-in (023_workspace_members.sql); a departure keeps that
-- from adding back someone who was removed or left. Adding them again
-- (api-py's add_member) deletes it.

CREATE TABLE workspace_departures (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  departed_at  timestamptz NOT NULL DEFAULT now(),
  -- Who removed them; themselves when they left.
  removed_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (workspace_id, user_id)
);

-- As in 023, except that someone who left the default workspace, or was removed
-- from it, is neither its bootstrap owner nor added back as a member.
CREATE OR REPLACE FUNCTION sign_in_memberships(uid uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  ws uuid;
  bootstrapped timestamptz;
BEGIN
  IF EXISTS (SELECT 1 FROM users WHERE id = uid AND subject = 'local') THEN
    RETURN;
  END IF;
  SELECT id, auth_bootstrapped_at INTO ws, bootstrapped FROM workspaces WHERE slug = 'default';
  IF ws IS NULL THEN
    RETURN;
  END IF;
  -- Already a member, after the bootstrap: nothing to do, and no lock.
  IF bootstrapped IS NOT NULL
     AND EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ws AND user_id = uid) THEN
    RETURN;
  END IF;
  -- The lock removal takes (api-py's workspaces.py): a removal in progress
  -- commits its departure before this looks for one, so it can't add them back.
  -- NO KEY UPDATE, so rows that only reference the workspace aren't held up.
  PERFORM 1 FROM workspaces WHERE id = ws FOR NO KEY UPDATE;
  IF EXISTS (SELECT 1 FROM workspace_departures WHERE workspace_id = ws AND user_id = uid) THEN
    RETURN;
  END IF;
  IF bootstrapped IS NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('knowledge-chatroom:first-owner'));
    SELECT auth_bootstrapped_at INTO bootstrapped FROM workspaces WHERE id = ws FOR UPDATE;
    IF bootstrapped IS NULL THEN
      INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (ws, uid, 'owner')
      ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = 'owner';
      INSERT INTO grants (workspace_id, node_id, principal_type, principal_id, role)
      VALUES (ws, NULL, 'user', uid, 'owner')
      ON CONFLICT (workspace_id, node_id, principal_type, principal_id) DO UPDATE SET role = 'owner';
      UPDATE workspaces SET auth_bootstrapped_at = now() WHERE id = ws;
    END IF;
  END IF;
  INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (ws, uid, 'member')
  ON CONFLICT DO NOTHING;
END $$;

-- Whether the workspace keeps an owner without `uid`. The built-in local user
-- (023) owns every workspace but nobody signs in as it, so it counts only when
-- `uid` is the local user too: once someone signed in owns a workspace, the
-- last of them can't leave it to the local user alone.
CREATE FUNCTION workspace_keeps_owner(ws uuid, uid uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM workspace_members m JOIN users u ON u.id = m.user_id
    WHERE m.workspace_id = ws AND m.role = 'owner' AND m.user_id <> uid
      AND (u.subject <> 'local' OR EXISTS (SELECT 1 FROM users WHERE id = uid AND subject = 'local')))
$$;

-- The keep-owner check from 023 looked for another owner without a lock, so two
-- owners demoting or removing each other at once could each still see the other
-- and both commit, leaving none. It now locks the workspace's row first: a
-- concurrent change waits for the other to commit, then looks again (each
-- query in a function sees what was committed before it started). api-py's
-- routes take the same lock before they ask workspace_keeps_owner.
CREATE OR REPLACE FUNCTION workspace_members_keep_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.role = 'owner' AND (TG_OP = 'DELETE' OR NEW.role <> 'owner') THEN
    PERFORM 1 FROM workspaces WHERE id = OLD.workspace_id FOR UPDATE;
    IF FOUND AND NOT workspace_keeps_owner(OLD.workspace_id, OLD.user_id) THEN
      RAISE EXCEPTION 'A workspace needs at least one owner';
    END IF;
  END IF;
  RETURN NULL;
END $$;
