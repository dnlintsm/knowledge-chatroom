import { AccessService, atLeast, ForbiddenError, type Principal, type Role } from "./access";
import { asUser, type Sql, type Tx } from "./db";
import type { WorkspaceEvent } from "./events";
import type { FileInfo, FileService, FileVersion } from "./files";
import { NodeNotFoundError, type KnowledgeNode, type NodeService, type NodeType } from "./nodes";

/**
 * Everything one principal (a user, or Claude acting for one) may do in the
 * workspace. The HTTP API and Claude's tools both go through here, so access
 * is checked and audited in one place. A node the principal can't see at all
 * is reported as not found, so its existence doesn't leak.
 *
 * With row-level security available, file and node queries also run as the
 * restricted database role for this principal (db.ts asUser), so Postgres
 * enforces the same rules if a check here is ever missed.
 */

export interface VisibleNode extends KnowledgeNode {
  /** null for a node shown only because something below it is visible. */
  role: Role | null;
}

export interface Tree {
  types: NodeType[];
  /** The principal's role at the workspace root (root files, top-level nodes). */
  rootRole: Role | null;
  nodes: VisibleNode[];
}

interface Parts {
  files: FileService;
  nodes: NodeService;
  access: AccessService;
  sql: Sql;
  /** Whether queries can run as the restricted role (db.ts prepareRowSecurity). */
  rowSecurity: boolean;
}

type Scoped = <T>(fn: (db: Sql | null) => Promise<T>) => Promise<T>;
const on = <S extends { withSql(sql: Sql): S }>(service: S, db: Sql | null) =>
  db ? service.withSql(db) : service;

export class Session {
  constructor(
    private readonly parts: Parts,
    readonly principal: Principal,
  ) {}

  role(nodeId: string | null): Promise<Role | null> {
    return this.parts.access.role(this.principal.userId, nodeId);
  }

  private async need(nodeId: string | null, min: Role): Promise<Role> {
    const role = await this.role(nodeId);
    if (role === null) {
      if (nodeId !== null) throw new NodeNotFoundError("Node not found");
      throw new ForbiddenError("You have no access to this workspace");
    }
    if (!atLeast(role, min)) throw new ForbiddenError(`This needs ${min} access`);
    return role;
  }

  /** Runs file and node queries for this principal (db = null without row security). */
  private readonly scoped: Scoped = (fn) =>
    this.parts.rowSecurity
      ? asUser(this.parts.sql, this.principal.userId, (db) => fn(db))
      : fn(null);

  private audit(action: string, target: Record<string, unknown>) {
    return (tx: Tx) => this.parts.access.audit(tx, this.principal, action, target);
  }

  // Knowledge tree

  async tree(): Promise<Tree> {
    const [types, all, roles, rootRole] = await Promise.all([
      this.parts.nodes.types(),
      this.scoped((db) => on(this.parts.nodes, db).list()),
      this.parts.access.nodeRoles(this.principal.userId),
      this.role(null),
    ]);
    const byId = new Map(all.map((n) => [n.id, n]));
    // Visible nodes, plus their ancestors so the path to them can be drawn.
    const shown = new Set<string>();
    for (const node of all) {
      if (!roles.get(node.id)) continue;
      for (let n: KnowledgeNode | undefined = node; n && !shown.has(n.id); n = byId.get(n.parentId ?? "")) {
        shown.add(n.id);
      }
    }
    const nodes = all
      .filter((n) => shown.has(n.id))
      .map((n) => {
        const role = roles.get(n.id) ?? null;
        return { ...n, role, fileCount: role ? n.fileCount : 0 };
      });
    return { types, rootRole, nodes };
  }

  async lineage(id: string): Promise<KnowledgeNode[]> {
    await this.need(id, "viewer");
    const lineage = await this.scoped((db) => on(this.parts.nodes, db).lineage(id));
    if (!lineage) throw new NodeNotFoundError("Node not found");
    return lineage;
  }

  async createNode(parentId: string | null, name: string) {
    await this.need(parentId, "editor");
    return this.scoped((db) =>
      on(this.parts.nodes, db).create(parentId, name, (tx, id) =>
        this.audit("node.create", { node: id, parent: parentId, name })(tx),
      ),
    );
  }

  async renameNode(id: string, name: string) {
    await this.need(id, "editor");
    return this.scoped((db) =>
      on(this.parts.nodes, db).rename(id, name, this.audit("node.rename", { node: id, name })),
    );
  }

  async deleteNode(id: string) {
    await this.need(id, "owner");
    return this.scoped((db) =>
      on(this.parts.nodes, db).remove(id, this.audit("node.delete", { node: id })),
    );
  }

  // Files

  /** Files at the workspace root (null) or in a node. */
  async files(nodeId: string | null): Promise<FilesSession> {
    const role = await this.need(nodeId, "viewer");
    const service = await this.parts.files.inNode(nodeId);
    if (!service) throw new NodeNotFoundError("Node not found");
    return new FilesSession(
      service,
      role,
      this.principal,
      (action, target) => this.audit(action, { node: nodeId, ...target }),
      (fn) => this.scoped((db) => fn(on(service, db))),
    );
  }

  /** Whether this principal may hear about a change. */
  async canSee(event: WorkspaceEvent): Promise<boolean> {
    // Hidden nodes stay hidden: not even their ids go out.
    if (event.op === "node") return this.parts.access.seesNode(this.principal.userId, event.id);
    return (await this.role(event.node)) !== null;
  }

  // Org tree and grants

  users() {
    return this.parts.access.users();
  }

  groups() {
    return this.parts.access.groups();
  }

  async createGroup(parentId: string | null, name: string) {
    await this.need(null, "owner");
    return this.parts.access.createGroup(parentId, name, (tx, id) =>
      this.audit("group.create", { group: id, parent: parentId, name })(tx),
    );
  }

  async renameGroup(id: string, name: string) {
    await this.need(null, "owner");
    return this.parts.access.renameGroup(id, name, this.audit("group.rename", { group: id, name }));
  }

  async deleteGroup(id: string) {
    await this.need(null, "owner");
    return this.parts.access.deleteGroup(id, this.audit("group.delete", { group: id }));
  }

  async setMember(groupId: string, userId: string, member: boolean) {
    await this.need(null, "owner");
    return this.parts.access.setMember(
      groupId,
      userId,
      member,
      this.audit(member ? "group.add_member" : "group.remove_member", { group: groupId, user: userId }),
    );
  }

  /** Grants on a node (null = workspace); owners of that node may see and change them. */
  async grants(nodeId: string | null) {
    await this.need(nodeId, "owner");
    return this.parts.access.grants(nodeId);
  }

  async setGrant(
    nodeId: string | null,
    principalType: "user" | "group",
    principalId: string,
    role: Role,
  ) {
    await this.need(nodeId, "owner");
    return this.parts.access.setGrant(
      nodeId,
      principalType,
      principalId,
      role,
      this.principal.userId,
      this.audit("grant.set", { node: nodeId, principalType, principalId, role }),
    );
  }

  async revoke(grantId: string) {
    const grant = (await this.parts.access.grants()).find((g) => g.id === grantId);
    if (!grant) return false;
    await this.need(grant.nodeId, "owner");
    return this.parts.access.revoke(
      grantId,
      this.audit("grant.revoke", {
        node: grant.nodeId,
        principalType: grant.principalType,
        principalId: grant.principalId,
      }),
    );
  }

  async auditLog(limit?: number) {
    await this.need(null, "owner");
    return this.parts.access.auditLog(limit);
  }
}

/**
 * One place's files, as one principal. Reads need viewer; writes and deletes
 * need editor, like in a shared folder (a deleted file keeps its history, so
 * nothing is lost). Deleting a whole node, and sharing, need owner.
 */
export class FilesSession {
  constructor(
    private readonly service: FileService,
    readonly role: Role,
    private readonly principal: Principal,
    private readonly audit: (
      action: string,
      target: Record<string, unknown>,
    ) => (tx: Tx) => Promise<unknown>,
    /** Runs `fn` with the service on this principal's connection. */
    private readonly run: <T>(fn: (service: FileService) => Promise<T>) => Promise<T>,
  ) {}

  get nodeId() {
    return this.service.nodeId;
  }

  private needEditor() {
    if (!atLeast(this.role, "editor")) throw new ForbiddenError("This needs editor access");
  }

  list(): Promise<FileInfo[]> {
    return this.run((s) => s.list());
  }

  stat(path: string) {
    return this.run((s) => s.stat(path));
  }

  read(path: string) {
    return this.run((s) => s.read(path));
  }

  history(path: string): Promise<FileVersion[] | null> {
    return this.run((s) => s.history(path));
  }

  async write(
    path: string,
    bytes: Uint8Array,
    opts: { mime?: string; createOnly?: boolean; readOnly?: boolean } = {},
  ) {
    this.needEditor();
    return this.run((s) =>
      s.write(path, bytes, {
        mime: opts.mime,
        createOnly: opts.createOnly,
        readOnly: opts.readOnly,
        author: this.principal.actor,
        authorId: this.principal.userId,
        inTx: this.audit("file.write", { path, size: bytes.byteLength }),
      }),
    );
  }

  async remove(path: string) {
    this.needEditor();
    return this.run((s) => s.remove(path, this.audit("file.delete", { path })));
  }
}
