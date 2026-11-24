-- Whoever adds a knowledge node owns it, so they can delete or share what
-- they made (Dan's call, 2026-10-14). Before, only owners could delete nodes,
-- so an editor couldn't remove a tech they had just added. Owners above the
-- node keep their access; nothing is granted to someone who already owns it.

CREATE FUNCTION own_new_node(ws uuid, uid uuid, node uuid, p ltree) RETURNS void
  LANGUAGE sql AS $$
  INSERT INTO grants (workspace_id, node_id, principal_type, principal_id, role, created_by)
  SELECT ws, node, 'user', uid, 'owner', uid
  WHERE coalesce(role_rank(path_role(ws, uid, p)), 0) < 3
  ON CONFLICT (workspace_id, node_id, principal_type, principal_id)
  DO UPDATE SET role = 'owner'
$$;

-- With row-level security on, node inserts run as knowledge_user, which can't
-- write grants; this trigger does it with the owner's rights, for the user the
-- insert runs as (app_user()). Without row security, session.ts calls
-- own_new_node itself.
CREATE FUNCTION nodes_own_new() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
BEGIN
  IF app_user() IS NOT NULL THEN
    PERFORM own_new_node(NEW.workspace_id, app_user(), NEW.id, NEW.path);
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER nodes_own_new AFTER INSERT ON nodes
  FOR EACH ROW EXECUTE FUNCTION nodes_own_new();
