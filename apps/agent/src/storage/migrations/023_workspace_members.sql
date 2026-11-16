-- Workspace membership (issue #226, docs/workspaces.md). A user belongs to a
-- workspace as owner, admin or member; a non-member gets nothing there.
-- Membership gives no content access by itself: that stays with grants.
-- Owners and admins manage people, groups and the audit log, which used to
-- need a root owner grant.

ALTER TABLE workspaces
  ADD COLUMN created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  -- When a real (signed-in) user first became owner; never cleared. While it
  -- is null, the first sign-in becomes owner (sign_in_memberships below).
  ADD COLUMN auth_bootstrapped_at timestamptz,
  -- For archiving, which comes later.
  ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived'));

CREATE TABLE workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (workspace_id, user_id)
);

CREATE INDEX workspace_members_by_user ON workspace_members (user_id);

-- Every workspace keeps an owner: removing or demoting the last one is refused
-- (unless the workspace itself is going).
CREATE FUNCTION workspace_members_keep_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.role = 'owner'
     AND (TG_OP = 'DELETE' OR NEW.role <> 'owner')
     AND EXISTS (SELECT 1 FROM workspaces WHERE id = OLD.workspace_id)
     AND NOT EXISTS (
       SELECT 1 FROM workspace_members
       WHERE workspace_id = OLD.workspace_id AND role = 'owner' AND user_id <> OLD.user_id) THEN
    RAISE EXCEPTION 'A workspace needs at least one owner';
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER workspace_members_keep_owner AFTER UPDATE OR DELETE ON workspace_members
  FOR EACH ROW EXECUTE FUNCTION workspace_members_keep_owner();

-- Backfill, from effective access rather than grant rows, so nobody loses
-- anything (docs/workspaces.md, "Backfill"). No grant changes.

-- Owners: a root owner grant, directly or through a group (nested groups too),
-- and the built-in local user of every workspace.
INSERT INTO workspace_members (workspace_id, user_id, role)
SELECT w.id, u.id, 'owner'
FROM workspaces w CROSS JOIN users u
WHERE u.subject = 'local' OR effective_role(w.id, u.id, NULL) = 'owner'
ON CONFLICT DO NOTHING;

-- Members: any other grant anywhere in the workspace, directly or through a group.
INSERT INTO workspace_members (workspace_id, user_id, role)
SELECT DISTINCT g.workspace_id, u.id, 'member'
FROM grants g JOIN users u ON grant_holder(u.id, g.principal_type, g.principal_id)
ON CONFLICT DO NOTHING;

-- Members: no grant, but their own data in the workspace stays reachable.
INSERT INTO workspace_members (workspace_id, user_id, role)
SELECT workspace_id, user_id, 'member' FROM (
  SELECT workspace_id, user_id FROM chats
  UNION SELECT workspace_id, user_id FROM memories
  UNION SELECT workspace_id, user_id FROM memory_settings
  UNION SELECT workspace_id, user_id FROM memory_incognito_chats
  UNION SELECT workspace_id, user_id FROM skill_settings
  UNION SELECT workspace_id, user_id FROM chat_skill_settings
) own
ON CONFLICT DO NOTHING;

-- A workspace that already has a signed-in owner has had its bootstrap. One
-- that only the local user owns stays open for the first sign-in.
UPDATE workspaces w SET auth_bootstrapped_at = now()
WHERE auth_bootstrapped_at IS NULL AND EXISTS (
  SELECT 1 FROM workspace_members m JOIN users u ON u.id = m.user_id
  WHERE m.workspace_id = w.id AND m.role = 'owner' AND u.subject <> 'local');

-- What signing in does to memberships, for both servers (user_for_subject in
-- api-py, userForSubject in apps/agent), in the sign-in's transaction:
--
-- 1. The one-time bootstrap: while the default workspace has no signed-in
--    owner yet, the first user to sign in becomes its owner, with Full access
--    on the root. An advisory lock makes concurrent first sign-ins produce one.
-- 2. Until the compatibility cut-off named in the CHANGELOG, every signed-in
--    user is a member of the default workspace, as everyone could open it
--    before memberships existed. Being a member gives no content access.
--
-- Other workspaces are never joined by signing in.
CREATE FUNCTION sign_in_memberships(uid uuid) RETURNS void LANGUAGE plpgsql AS $$
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
