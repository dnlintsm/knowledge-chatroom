-- Step 4c of #4: the database enforces access too. A signed-in user's file
-- and node queries run as the knowledge_user role with app.user_id set
-- (db.ts asUser), and these policies limit them to what that user's grants
-- allow. The app checks access first (session.ts); this is the safety net
-- if a check is ever missed. The connection's own role owns the tables, so
-- system work (migrations, listing users, the change stream) is unaffected.

-- The user a query runs for; null outside asUser().
CREATE FUNCTION app_user() RETURNS uuid
  LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;

-- Grants and group membership are read with the owner's rights, so the
-- policies below can use them without being limited by policies themselves.
ALTER FUNCTION effective_role(uuid, uuid, uuid) SECURITY DEFINER SET search_path FROM CURRENT;

-- Whether a grant names `uid`, directly or through a group or sub-group.
CREATE FUNCTION grant_holder(uid uuid, principal_type text, principal_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
  SELECT (principal_type = 'user' AND principal_id = uid)
      OR (principal_type = 'group' AND EXISTS (
            SELECT 1 FROM groups pg
            JOIN groups mg ON pg.path @> mg.path
            JOIN group_members m ON m.group_id = mg.id
            WHERE pg.id = principal_id AND m.user_id = uid))
$$;

-- The role on the node at `p` (a node's path), from the row itself, so it
-- also works for a row being inserted or updated.
CREATE FUNCTION path_role(ws uuid, uid uuid, p ltree) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
  SELECT g.role
  FROM grants g LEFT JOIN nodes a ON a.id = g.node_id
  WHERE g.workspace_id = ws
    AND (g.node_id IS NULL OR a.path @> p)
    AND grant_holder(uid, g.principal_type, g.principal_id)
  ORDER BY role_rank(g.role) DESC
  LIMIT 1
$$;

-- Whether the node at `p` is visible: a role on it, or on something below it
-- (it is then shown as the path there, as session.ts tree() does).
CREATE FUNCTION sees_path(ws uuid, uid uuid, p ltree) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
  SELECT EXISTS (
    SELECT 1
    FROM grants g LEFT JOIN nodes a ON a.id = g.node_id
    WHERE g.workspace_id = ws
      AND (g.node_id IS NULL OR a.path @> p OR a.path <@ p)
      AND grant_holder(uid, g.principal_type, g.principal_id))
$$;

ALTER TABLE nodes ENABLE ROW LEVEL SECURITY;
CREATE POLICY nodes_read ON nodes FOR SELECT
  USING (sees_path(workspace_id, app_user(), path));
CREATE POLICY nodes_add ON nodes FOR INSERT
  WITH CHECK (role_rank(effective_role(workspace_id, app_user(), parent_id)) >= 2);
CREATE POLICY nodes_change ON nodes FOR UPDATE
  USING (role_rank(path_role(workspace_id, app_user(), path)) >= 2)
  WITH CHECK (role_rank(path_role(workspace_id, app_user(), path)) >= 2);

ALTER TABLE files ENABLE ROW LEVEL SECURITY;
CREATE POLICY files_read ON files FOR SELECT
  USING (effective_role(workspace_id, app_user(), node_id) IS NOT NULL);
CREATE POLICY files_add ON files FOR INSERT
  WITH CHECK (role_rank(effective_role(workspace_id, app_user(), node_id)) >= 2);
CREATE POLICY files_change ON files FOR UPDATE
  USING (role_rank(effective_role(workspace_id, app_user(), node_id)) >= 2)
  WITH CHECK (role_rank(effective_role(workspace_id, app_user(), node_id)) >= 2);

ALTER TABLE file_versions ENABLE ROW LEVEL SECURITY;
-- The subqueries see files through files' own policies.
CREATE POLICY file_versions_read ON file_versions FOR SELECT
  USING (EXISTS (SELECT 1 FROM files f WHERE f.id = file_id));
CREATE POLICY file_versions_add ON file_versions FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM files f
    WHERE f.id = file_id
      AND role_rank(effective_role(f.workspace_id, app_user(), f.node_id)) >= 2));

-- The role itself. Roles belong to the whole Postgres server, so this needs
-- CREATEROLE (or a superuser); without it the app runs with its own checks
-- only and says so at startup. An admin can then create it later:
--   CREATE ROLE knowledge_user NOLOGIN; GRANT knowledge_user TO <app user>;
-- and the app grants it what it needs on its next start (db.ts).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'knowledge_user') THEN
    CREATE ROLE knowledge_user NOLOGIN;
  END IF;
  EXECUTE format('GRANT knowledge_user TO %I', current_user);
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Could not set up role knowledge_user; row-level security stays off';
END
$$;
