-- Access control (issue #4, step 4): users, an org tree of groups, and grants
-- that join the org tree to the knowledge tree. Roles are additive (viewer <
-- editor < owner, no deny rules) and inherit down both trees: a grant on a
-- node covers everything below it, and a grant to a group covers members of
-- that group and of every group below it.

CREATE TABLE users (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stable identity from the login provider ("<issuer>|<sub>"), or 'local'
  -- for the single user of a deployment without login.
  subject    text NOT NULL UNIQUE,
  email      text,
  name       text,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO users (subject, name) VALUES ('local', 'Local user');

-- Org tree: company › dept › team, any depth.
CREATE TABLE groups (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_id    uuid REFERENCES groups(id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 200),
  -- Ancestor ids (dashes dropped) down to this group, like nodes.path.
  path         ltree NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX groups_path ON groups USING gist (path);
CREATE UNIQUE INDEX groups_name ON groups (workspace_id, parent_id, lower(name))
  NULLS NOT DISTINCT;

CREATE FUNCTION groups_place() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_path ltree;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.parent_id IS DISTINCT FROM OLD.parent_id OR NEW.path <> OLD.path
       OR NEW.workspace_id <> OLD.workspace_id THEN
      RAISE EXCEPTION 'A group''s parent and path cannot change';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.parent_id IS NULL THEN
    NEW.path := replace(NEW.id::text, '-', '')::ltree;
  ELSE
    SELECT path INTO parent_path FROM groups
    WHERE id = NEW.parent_id AND workspace_id = NEW.workspace_id;
    IF parent_path IS NULL THEN
      RAISE EXCEPTION 'Parent group not found';
    END IF;
    NEW.path := parent_path || replace(NEW.id::text, '-', '')::ltree;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER groups_place BEFORE INSERT OR UPDATE ON groups
  FOR EACH ROW EXECUTE FUNCTION groups_place();

CREATE TABLE group_members (
  group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, user_id)
);

CREATE INDEX group_members_by_user ON group_members (user_id);

-- A role for a user or a group on a node and everything below it; node_id
-- NULL means the whole workspace (its root files included).
CREATE TABLE grants (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  node_id        uuid REFERENCES nodes(id) ON DELETE CASCADE,
  principal_type text NOT NULL CHECK (principal_type IN ('user', 'group')),
  principal_id   uuid NOT NULL,
  role           text NOT NULL CHECK (role IN ('viewer', 'editor', 'owner')),
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX grants_one_per_principal
  ON grants (workspace_id, node_id, principal_type, principal_id) NULLS NOT DISTINCT;
CREATE INDEX grants_by_principal ON grants (principal_type, principal_id);

-- Deleting a user or group takes its grants with it.
CREATE FUNCTION grants_drop_principal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM grants WHERE principal_type = TG_ARGV[0] AND principal_id = OLD.id;
  RETURN OLD;
END $$;
CREATE TRIGGER users_drop_grants AFTER DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION grants_drop_principal('user');
CREATE TRIGGER groups_drop_grants AFTER DELETE ON groups
  FOR EACH ROW EXECUTE FUNCTION grants_drop_principal('group');

-- The local user owns every existing workspace, so a deployment without login
-- keeps working exactly as before.
INSERT INTO grants (workspace_id, node_id, principal_type, principal_id, role)
SELECT w.id, NULL, 'user', u.id, 'owner'
FROM workspaces w, users u WHERE u.subject = 'local';

CREATE FUNCTION role_rank(role text) RETURNS int
  LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE role WHEN 'viewer' THEN 1 WHEN 'editor' THEN 2 WHEN 'owner' THEN 3 ELSE 0 END
$$;

-- The user's best role on a node (NULL = the workspace root), or NULL if none:
-- the strongest grant on the node or an ancestor, or on the workspace, to the
-- user or to a group the user is in (directly or through a sub-group).
CREATE FUNCTION effective_role(ws uuid, uid uuid, target uuid) RETURNS text
  LANGUAGE sql STABLE AS $$
  SELECT g.role
  FROM grants g
  WHERE g.workspace_id = ws
    AND (g.node_id IS NULL
         OR (target IS NOT NULL AND EXISTS (
               SELECT 1 FROM nodes a, nodes t
               WHERE a.id = g.node_id AND t.id = target AND a.path @> t.path)))
    AND ((g.principal_type = 'user' AND g.principal_id = uid)
         OR (g.principal_type = 'group' AND EXISTS (
               SELECT 1 FROM groups pg
               JOIN groups mg ON pg.path @> mg.path
               JOIN group_members m ON m.group_id = mg.id
               WHERE pg.id = g.principal_id AND m.user_id = uid)))
  ORDER BY role_rank(g.role) DESC
  LIMIT 1
$$;

-- Who did what. Rows are only ever added.
CREATE TABLE audit_log (
  id           bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_type   text NOT NULL CHECK (actor_type IN ('user', 'agent')),
  -- The user, or the user Claude was acting for.
  actor_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  action       text NOT NULL,
  target       jsonb NOT NULL DEFAULT '{}',
  at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_by_time ON audit_log (workspace_id, at DESC);
