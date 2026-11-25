-- Restricted Knowledge nodes (docs/restricted-knowledge.md). A restricted node
-- stops inheritance from above: grants on its ancestors and on the workspace
-- root no longer reach it or anything below it. Grants on it and below it
-- work as before. The nearest restricted node at or above a node is its
-- boundary.
--
-- Content access is decided in three functions (effective_role, path_role,
-- sees_path), so they are the only ones that change: files, versions,
-- experiments, search, proposals, shared memory, events and row security
-- already go through them.

ALTER TABLE nodes
  ADD COLUMN restricted boolean NOT NULL DEFAULT false,
  ADD COLUMN restricted_at timestamptz,
  ADD COLUMN restricted_by uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX nodes_restricted ON nodes USING gist (path) WHERE restricted;

-- A grant an Owner gave themselves by taking a restricted node over, shown to
-- everyone who can open the node.
ALTER TABLE grants ADD COLUMN takeover boolean NOT NULL DEFAULT false;

-- The path of the nearest restricted node at or above `p`, or NULL. Deleted
-- nodes keep their boundary: deleting never widens access.
CREATE FUNCTION restriction_boundary(ws uuid, p ltree) RETURNS ltree
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
  SELECT r.path FROM nodes r
  WHERE p IS NOT NULL AND r.workspace_id = ws AND r.restricted AND r.path @> p
  ORDER BY nlevel(r.path) DESC
  LIMIT 1
$$;

-- The strongest role on the node at `p` (NULL = the root) from grants at or
-- below boundary `b`; with no boundary, root grants count too.
CREATE FUNCTION role_within(ws uuid, uid uuid, p ltree, b ltree) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
  SELECT g.role
  FROM grants g LEFT JOIN nodes a ON a.id = g.node_id
  WHERE g.workspace_id = ws
    AND ((g.node_id IS NULL AND b IS NULL)
         OR (p IS NOT NULL AND a.path @> p AND (b IS NULL OR b @> a.path)))
    AND grant_holder(uid, g.principal_type, g.principal_id)
  ORDER BY role_rank(g.role) DESC
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION path_role(ws uuid, uid uuid, p ltree) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
  SELECT role_within(ws, uid, p, restriction_boundary(ws, p))
$$;

-- An unknown node counts as the root, as before.
CREATE OR REPLACE FUNCTION effective_role(ws uuid, uid uuid, target uuid) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
  SELECT path_role(ws, uid, (SELECT t.path FROM nodes t WHERE t.id = target))
$$;

-- Whether the node at `p` shows in the tree: a role on it, a grant below it
-- (it is then the path there), or, for an Owner or Admin, it is restricted or
-- on the path to a restricted node (its name only).
CREATE OR REPLACE FUNCTION sees_path(ws uuid, uid uuid, p ltree) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
  SELECT path_role(ws, uid, p) IS NOT NULL
      OR EXISTS (
        SELECT 1 FROM grants g JOIN nodes a ON a.id = g.node_id
        WHERE g.workspace_id = ws AND a.path <@ p
          AND grant_holder(uid, g.principal_type, g.principal_id))
      OR (workspace_manager(ws, uid) AND EXISTS (
        SELECT 1 FROM nodes r WHERE r.workspace_id = ws AND r.restricted AND r.path <@ p))
$$;

-- Only someone with Full access on a node changes whether it is restricted.
-- The routes check this first; this holds under row security if one doesn't.
CREATE FUNCTION nodes_guard_restricted() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW.restricted IS DISTINCT FROM OLD.restricted AND app_user() IS NOT NULL
     AND coalesce(path_role(OLD.workspace_id, app_user(), OLD.path), '') <> 'owner' THEN
    RAISE EXCEPTION 'Only someone with Full access can change whether a node is restricted';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER nodes_guard_restricted BEFORE UPDATE OF restricted ON nodes
  FOR EACH ROW EXECUTE FUNCTION nodes_guard_restricted();

-- The restricted nodes that adding someone to group `grp` would open to them,
-- where `actor` lacks Full access: the boundary of each grant held by the
-- group or a group above it, on a node inside a restricted one.
CREATE FUNCTION group_crossings(ws uuid, actor uuid, grp uuid)
  RETURNS TABLE (node_id uuid, name text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
  SELECT DISTINCT r.id, r.name
  FROM groups mg
  JOIN groups pg ON pg.path @> mg.path AND pg.workspace_id = mg.workspace_id
  JOIN grants g ON g.principal_type = 'group' AND g.principal_id = pg.id
  JOIN nodes a ON a.id = g.node_id
  JOIN nodes r ON r.workspace_id = ws AND r.path = restriction_boundary(ws, a.path)
  WHERE mg.id = grp AND mg.workspace_id = ws
    AND coalesce(path_role(ws, actor, r.path), '') <> 'owner'
$$;

-- Whether deleting the node at `p` would reach a restricted node below it that
-- `uid` doesn't have Full access on: then nothing is deleted. It locks the
-- subtree first, with the owner's rights (rows the caller can't see too), so a
-- node restricted meanwhile waits for the delete or is seen by it.
CREATE FUNCTION delete_blocked(ws uuid, uid uuid, p ltree) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
BEGIN
  PERFORM 1 FROM nodes WHERE workspace_id = ws AND path <@ p AND deleted_at IS NULL FOR UPDATE;
  RETURN EXISTS (
    SELECT 1 FROM nodes r
    WHERE r.workspace_id = ws AND r.restricted AND r.deleted_at IS NULL
      AND r.path <@ p AND r.path <> p
      AND coalesce(path_role(ws, uid, r.path), '') <> 'owner');
END $$;

-- A proposal is seen by whoever can view its node now, its author included:
-- an author who loses access there loses the proposal too.
DROP POLICY proposals_read ON proposals;
CREATE POLICY proposals_read ON proposals FOR SELECT
  USING (place_rank(workspace_id, app_user(), node_id, NULL) >= 1);
DROP POLICY proposals_change ON proposals;
CREATE POLICY proposals_change ON proposals FOR UPDATE
  USING ((author_id = app_user() AND place_rank(workspace_id, app_user(), node_id, NULL) >= 1)
         OR place_rank(workspace_id, app_user(), node_id, NULL) >= 2)
  WITH CHECK (place_rank(workspace_id, app_user(), node_id, NULL) >= 2
              OR (author_id = app_user() AND place_rank(workspace_id, app_user(), node_id, NULL) >= 1
                  AND status IN ('open', 'withdrawn')));
