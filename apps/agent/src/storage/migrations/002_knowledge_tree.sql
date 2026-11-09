-- Knowledge tree (issue #4, step 3): nodes such as tech › module › loop ›
-- process, with files attached at any level. Files without a node stay at the
-- workspace root, so everything from step 1 keeps working.

CREATE EXTENSION IF NOT EXISTS ltree;

-- The levels are data, so a deployment can rename or add them. depth 1 is the
-- top level; a node's type is always one level below its parent's.
CREATE TABLE node_types (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (btrim(name) <> ''),
  depth        int  NOT NULL CHECK (depth >= 1),
  UNIQUE (workspace_id, depth),
  UNIQUE (workspace_id, name)
);

INSERT INTO node_types (workspace_id, name, depth)
SELECT w.id, t.name, t.depth
FROM workspaces w,
     (VALUES ('tech', 1), ('module', 2), ('loop', 3), ('process', 4)) AS t(name, depth);

CREATE TABLE nodes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- Fixed once created; moving nodes can come later.
  parent_id    uuid REFERENCES nodes(id),
  type_id      uuid NOT NULL REFERENCES node_types(id),
  name         text NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 200),
  -- Ancestor ids (dashes dropped) down to this node, so renames never touch
  -- it and subtree checks are indexed: path <@ some_node.path.
  path         ltree NOT NULL,
  metadata     jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);

CREATE INDEX nodes_path ON nodes USING gist (path);
CREATE UNIQUE INDEX nodes_live_name ON nodes (workspace_id, parent_id, lower(name))
  NULLS NOT DISTINCT WHERE deleted_at IS NULL;

-- Sets path and checks the level on insert; keeps parent, type and path fixed
-- afterwards.
CREATE FUNCTION nodes_place() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_path  ltree;
  parent_depth int;
  own_depth    int;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.parent_id IS DISTINCT FROM OLD.parent_id OR NEW.type_id <> OLD.type_id
       OR NEW.path <> OLD.path OR NEW.workspace_id <> OLD.workspace_id THEN
      RAISE EXCEPTION 'A node''s parent, type and path cannot change';
    END IF;
    RETURN NEW;
  END IF;

  SELECT depth INTO own_depth FROM node_types
  WHERE id = NEW.type_id AND workspace_id = NEW.workspace_id;
  IF own_depth IS NULL THEN
    RAISE EXCEPTION 'Node type is not part of this workspace';
  END IF;

  IF NEW.parent_id IS NULL THEN
    parent_depth := 0;
    NEW.path := replace(NEW.id::text, '-', '')::ltree;
  ELSE
    SELECT n.path, t.depth INTO parent_path, parent_depth
    FROM nodes n JOIN node_types t ON t.id = n.type_id
    WHERE n.id = NEW.parent_id AND n.workspace_id = NEW.workspace_id
      AND n.deleted_at IS NULL;
    IF parent_path IS NULL THEN
      RAISE EXCEPTION 'Parent node not found';
    END IF;
    NEW.path := parent_path || replace(NEW.id::text, '-', '')::ltree;
  END IF;

  IF own_depth <> parent_depth + 1 THEN
    RAISE EXCEPTION 'A child node must sit exactly one level below its parent';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER nodes_place BEFORE INSERT OR UPDATE ON nodes
  FOR EACH ROW EXECUTE FUNCTION nodes_place();

-- Files attach to one node, or to the workspace root when node_id is null.
-- Each node has its own path namespace.
ALTER TABLE files ADD COLUMN node_id uuid REFERENCES nodes(id);
DROP INDEX files_live_path;
CREATE UNIQUE INDEX files_live_path ON files (workspace_id, node_id, path)
  NULLS NOT DISTINCT WHERE deleted_at IS NULL;
CREATE INDEX files_by_node ON files (node_id) WHERE deleted_at IS NULL;
