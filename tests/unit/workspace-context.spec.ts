import { test, expect } from "@playwright/test";
import { lineageOf, resolvePlaceContext } from "../../src/components/workspace/workspace-context";
import { experimentPlace, type Experiment, type KnowledgeNode, type KnowledgeTree } from "../../src/components/workspace/server-files";

const parent: KnowledgeNode = { id: "tech", parentId: null, name: "Tech", type: "tech", depth: 1, fileCount: 0, updatedAt: "2026-10-12", role: "owner" };
const child: KnowledgeNode = { ...parent, id: "module", parentId: "tech", name: "Module", type: "module", depth: 2, role: "viewer" };
const tree: KnowledgeTree = { types: [], rootRole: "editor", nodes: [child, parent] };
const experiment: Experiment = {
  id: "exp", nodeId: "module", authorId: "alice", authorName: "Alice", title: "Draft",
  hypothesis: "", params: {}, results: {}, status: "draft", forkedAt: "2026-10-12",
  updatedAt: "2026-10-12", fileCount: 0, access: "writer", mine: true,
};

test("root/node permissions come from the correct place and local mode retains ownership", () => {
  expect(resolvePlaceContext("server", null, tree, [])).toMatchObject({ node: null, placeRole: "editor", canEdit: true, lineage: [] });
  expect(resolvePlaceContext("server", "module", tree, [])).toMatchObject({ node: "module", placeRole: "viewer", canEdit: false, lineage: [parent, child] });
  expect(resolvePlaceContext("server", "missing", tree, [])).toMatchObject({ placeRole: null, canEdit: false });
  expect(resolvePlaceContext("local", null, { ...tree, rootRole: null }, []).canEdit).toBe(true);
  expect(resolvePlaceContext("server", null, { ...tree, rootRole: null }, []).canEdit).toBe(false);
});

test("experiment access determines editing even when parent roles or ownership differ", () => {
  const place = experimentPlace("exp");
  expect(resolvePlaceContext("server", place, tree, [experiment])).toMatchObject({ node: "module", placeRole: "editor", canEdit: true, lineage: [parent, child] });
  const archived: Experiment = { ...experiment, status: "archived", access: "reader" };
  expect(resolvePlaceContext("server", place, tree, [archived])).toMatchObject({ placeRole: "viewer", canEdit: false });
  expect(resolvePlaceContext("server", place, tree, [])).toMatchObject({ node: null, experiment: null, placeRole: null, canEdit: false });
});

test("lineage is ordered without mutating catalog order and unknown nodes have no path", () => {
  expect(lineageOf(tree.nodes, "module")).toEqual([parent, child]);
  expect(tree.nodes).toEqual([child, parent]);
  expect(lineageOf(tree.nodes, "missing")).toEqual([]);
});
