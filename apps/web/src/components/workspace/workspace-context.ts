import { experimentOf, type Experiment, type KnowledgeNode, type KnowledgeTree, type NodeId, type PlaceId, type Role } from "./server-files";
import type { StorageMode } from "./save-scheduler";
import { hasRole } from "./roles";

/** `id` and its ancestors, top level first. */
export function lineageOf(nodes: KnowledgeNode[], id: string): KnowledgeNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const chain: KnowledgeNode[] = [];
  for (let node = byId.get(id); node; node = node.parentId ? byId.get(node.parentId) : undefined) chain.unshift(node);
  return chain;
}

/** UI context is derived from server access metadata, never from file contents. */
export function resolvePlaceContext(mode: StorageMode, place: PlaceId, tree: KnowledgeTree, experiments: Experiment[]) {
  const experimentId = experimentOf(place);
  const experiment = experimentId ? (experiments.find((item) => item.id === experimentId) ?? null) : null;
  const node: NodeId = experimentId ? (experiment?.nodeId ?? null) : place;
  const placeRole: Role | null = mode !== "server" ? "owner"
    : experimentId ? experiment ? experiment.access === "writer" ? "editor" : "viewer" : null
    : node ? (tree.nodes.find((item) => item.id === node)?.role ?? null) : tree.rootRole;
  return {
    experiment, node, lineage: node ? lineageOf(tree.nodes, node) : [],
    placeRole, canEdit: hasRole(placeRole, "editor"),
  };
}
