import { AccessService, atLeast, ForbiddenError, type Principal, type Role } from "./access";
import { asUser, type Sql, type Tx } from "./db";
import type { WorkspaceEvent } from "./events";
import type { Experiment, ExperimentInput, ExperimentService } from "./experiments";
import type { FileInfo, FileService, FileVersion } from "./files";
import { NodeNotFoundError, type KnowledgeNode, type NodeService, type NodeType } from "./nodes";
import {
  ProposalError,
  type Decision,
  type ListOptions as ProposalListOptions,
  type Promotable,
  type Proposal,
  type ProposalService,
} from "./proposals";
import type { SearchHit, SearchOptions, SearchService } from "./search";

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
  experiments: ExperimentService;
  access: AccessService;
  search: SearchService;
  proposals: ProposalService;
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

  // Experiments: anyone who can view a node may fork it into their own
  // experiment; only its author changes it (see 005_experiments.sql).

  /** Experiments you can see, on one node or anywhere. */
  async experiments(nodeId?: string): Promise<Experiment[]> {
    if (nodeId !== undefined) await this.need(nodeId, "viewer");
    const userId = this.principal.userId;
    return this.scoped((db) => on(this.parts.experiments, db).list(userId, nodeId));
  }

  async experiment(id: string): Promise<Experiment> {
    const userId = this.principal.userId;
    const found = await this.scoped((db) => on(this.parts.experiments, db).get(userId, id));
    if (!found) throw new NodeNotFoundError("Experiment not found");
    return found;
  }

  async createExperiment(nodeId: string, input: ExperimentInput): Promise<Experiment> {
    await this.need(nodeId, "viewer");
    const userId = this.principal.userId;
    return this.scoped((db) =>
      on(this.parts.experiments, db).create(userId, nodeId, input, (tx, id) =>
        this.audit("experiment.create", { experiment: id, node: nodeId, title: input.title })(tx),
      ),
    );
  }

  /** Archived experiments are read only, apart from changing the status back. */
  async updateExperiment(id: string, input: ExperimentInput): Promise<Experiment> {
    const current = await this.experiment(id);
    this.needAuthor(current);
    const archived = current.status === "archived" && (input.status ?? "archived") === "archived";
    if (archived && Object.keys(input).some((k) => k !== "status")) {
      throw new ForbiddenError("This experiment is archived; restore it to change it");
    }
    await this.scoped((db) =>
      on(this.parts.experiments, db).update(
        id,
        input,
        this.audit("experiment.update", { experiment: id, fields: Object.keys(input) }),
      ),
    );
    return this.experiment(id);
  }

  async deleteExperiment(id: string): Promise<boolean> {
    this.needAuthor(await this.experiment(id));
    return this.scoped((db) =>
      on(this.parts.experiments, db).remove(id, this.audit("experiment.delete", { experiment: id })),
    );
  }

  private needAuthor(experiment: Experiment) {
    if (!experiment.mine) {
      throw new ForbiddenError("Only the experiment's author can change it");
    }
  }

  // Files

  /** Files at the workspace root (null) or in a node. */
  async files(nodeId: string | null): Promise<FilesSession> {
    const role = await this.need(nodeId, "viewer");
    const service = await this.parts.files.inNode(nodeId);
    if (!service) throw new NodeNotFoundError("Node not found");
    return this.filesSession(service, role, { node: nodeId });
  }

  /** An experiment's files: its author edits them, others who may see it read them. */
  async experimentFiles(id: string): Promise<FilesSession> {
    const access = await this.parts.experiments.access(this.principal.userId, id);
    const service = access && (await this.parts.files.inExperiment(id));
    if (!service) throw new NodeNotFoundError("Experiment not found");
    return this.filesSession(service, access === "writer" ? "editor" : "viewer", { experiment: id });
  }

  private filesSession(service: FileService, role: Role, place: Record<string, string | null>) {
    return new FilesSession(
      service,
      role,
      this.principal,
      (action, target) => this.audit(action, { ...place, ...target }),
      (fn) => this.scoped((db) => fn(on(service, db))),
    );
  }

  // Proposed versions (see proposals.ts): anyone who can read a place may
  // propose a change to its files, and editors there accept or reject it.

  /** Proposals you can see: on places you can read, and your own. */
  proposals(opts: ProposalListOptions = {}): Promise<Proposal[]> {
    const userId = this.principal.userId;
    return this.scoped((db) => on(this.parts.proposals, db).list(userId, opts));
  }

  async proposal(id: string): Promise<Proposal> {
    const userId = this.principal.userId;
    const found = await this.scoped((db) => on(this.parts.proposals, db).get(userId, id));
    if (!found) throw new NodeNotFoundError("Proposal not found");
    return found;
  }

  /** A proposal and its proposed bytes. */
  async proposalContent(id: string): Promise<{ proposal: Proposal; bytes: Uint8Array }> {
    const proposal = await this.proposal(id);
    return { proposal, bytes: await this.parts.proposals.content(proposal) };
  }

  /** Proposes new content for a file at the root (null) or in a node; returns the proposal. */
  async propose(
    nodeId: string | null,
    path: string,
    bytes: Uint8Array,
    opts: { mime?: string; note?: string } = {},
  ): Promise<Proposal> {
    await this.need(nodeId, "viewer");
    const { userId, actor } = this.principal;
    const id = await this.scoped((db) =>
      on(this.parts.proposals, db).propose(
        { node: nodeId, path, content: bytes, mime: opts.mime, author: actor, authorId: userId, note: opts.note },
        (tx, proposal) => this.audit("proposal.create", { proposal, node: nodeId, path })(tx),
      ),
    );
    return this.proposal(id);
  }

  /** What promoting an experiment would propose to its node. */
  async promotable(experimentId: string): Promise<Promotable[]> {
    await this.experiment(experimentId);
    return this.scoped((db) => on(this.parts.proposals, db).promotable(experimentId));
  }

  /**
   * Proposes an experiment's changed files (all of them, or those in `paths`)
   * to its node, for someone who can edit there to accept. Only its author
   * promotes it, and not once it is archived.
   */
  async promote(experimentId: string, paths?: string[], note?: string): Promise<Proposal[]> {
    const experiment = await this.experiment(experimentId);
    this.needAuthor(experiment);
    if (experiment.access !== "writer") {
      throw new ForbiddenError("This experiment is archived; restore it to propose its files");
    }
    const candidates = await this.promotable(experimentId);
    const chosen = paths ? candidates.filter((c) => paths.includes(c.path)) : candidates;
    const missing = paths?.filter((p) => !candidates.some((c) => c.path === p)) ?? [];
    if (missing.length) {
      throw new ProposalError(
        `Nothing to propose for ${missing.join(", ")}: the experiment didn't change it, or its node already has it`,
      );
    }
    if (!chosen.length) throw new ProposalError("This experiment has no changes its node doesn't have");
    const { userId, actor } = this.principal;
    const ids: string[] = [];
    for (const c of chosen) {
      const id = await this.scoped(async (db) => {
        const proposals = on(this.parts.proposals, db);
        const file = await proposals.experimentFile(experimentId, c.path);
        if (!file) throw new ProposalError(`${c.path} is no longer in this experiment`);
        return proposals.propose(
          {
            node: experiment.nodeId,
            path: c.path,
            content: file,
            mime: file.mime,
            author: actor,
            authorId: userId,
            experimentId,
            note,
          },
          (tx, proposal) =>
            this.audit("proposal.create", { proposal, node: experiment.nodeId, path: c.path, experiment: experimentId })(tx),
        );
      });
      ids.push(id);
    }
    return Promise.all(ids.map((id) => this.proposal(id)));
  }

  /**
   * Accepts (writes it as the file's next version, credited to its proposer),
   * rejects, or withdraws a proposal. Accepting and rejecting need editor on
   * its place; withdrawing is for its proposer.
   */
  async decide(id: string, decision: Decision): Promise<Proposal> {
    const proposal = await this.proposal(id);
    if (proposal.status !== "open") {
      throw new ProposalError(`This proposal was already ${proposal.status}`);
    }
    if (decision === "withdraw") {
      if (!proposal.mine) throw new ForbiddenError("Only its proposer can withdraw a proposal");
    } else {
      await this.need(proposal.node, "editor");
    }
    const userId = this.principal.userId;
    const audit = this.audit(`proposal.${decision}`, { proposal: id, node: proposal.node, path: proposal.path });
    if (decision !== "accept") {
      await this.scoped((db) => on(this.parts.proposals, db).decide(id, decision, userId, audit));
      return this.proposal(id);
    }
    const files = await this.parts.files.inNode(proposal.node);
    if (!files) throw new NodeNotFoundError("Node not found");
    const bytes = await this.parts.proposals.content(proposal);
    await this.scoped(async (db) => {
      const proposals = on(this.parts.proposals, db);
      let decided = false;
      await on(files, db).write(proposal.path, bytes, {
        mime: proposal.mime,
        author: proposal.author,
        authorId: proposal.authorId,
        inTx: async (tx) => {
          await proposals.decideIn(tx, id, "accept", userId);
          await audit(tx);
          decided = true;
        },
      });
      // The file already had these bytes, so no version was added.
      if (!decided) await proposals.decide(id, "accept", userId, audit);
    });
    return this.proposal(id);
  }

  /** Files this principal may read that match, best first (see search.ts). */
  search(opts: SearchOptions): Promise<SearchHit[]> {
    return this.scoped((db) => on(this.parts.search, db).search(this.principal.userId, opts));
  }

  /** Whether this principal may hear about a change. */
  async canSee(event: WorkspaceEvent): Promise<boolean> {
    const userId = this.principal.userId;
    // Hidden nodes stay hidden: not even their ids go out.
    if (event.op === "node") return this.parts.access.seesNode(userId, event.id);
    if (event.op === "experiment") return this.parts.experiments.hears(userId, event.id, event.change);
    if (event.op === "proposal") return event.authorId === userId || (await this.role(event.node)) !== null;
    if (event.experiment) return (await this.parts.experiments.access(userId, event.experiment)) !== null;
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

  get experimentId() {
    return this.service.experimentId;
  }

  private needEditor() {
    if (atLeast(this.role, "editor")) return;
    throw new ForbiddenError(
      this.experimentId
        ? "Only the experiment's author can change its files, and not once it is archived"
        : "This needs editor access",
    );
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

  async write(path: string, bytes: Uint8Array, opts: { mime?: string } = {}) {
    this.needEditor();
    return this.run((s) =>
      s.write(path, bytes, {
        mime: opts.mime,
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
