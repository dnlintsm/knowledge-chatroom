import type { IncomingMessage, ServerResponse } from "node:http";

import { AccessError, ForbiddenError, ROLES, type Principal, type Role } from "./access";
import { ChatError, ChatTakenError } from "./chats";
import type { EventHub, WorkspaceEvent } from "./events";
import { ExperimentError, type ExperimentInput } from "./experiments";
import { identify } from "./identity";
import type { Storage, StorageState } from "./index";
import { FileExistsError, listLevel, ReadOnlyFileError } from "./files";
import { NodeError, NodeNotFoundError } from "./nodes";
import { InvalidPathError, isTextFile, kindForPath, normalizePath } from "./paths";
import { ProposalError, type Decision, type ProposalStatus } from "./proposals";
import { SearchError } from "./search";
import type { Session } from "./session";

/**
 * REST API for workspace files, the knowledge tree, experiments, search and
 * access, mounted on the agent server:
 *
 *   GET    /files                   list live files (JSON), each with
 *                                   workspaceId, nodeId and experimentId
 *   GET    /files?depth=<n>&dir=<folder>
 *                                   one level at a time: {files, folders}, the
 *                                   files at most n folders below dir (both
 *                                   optional; no dir = the top) and the folders
 *                                   at depth n with more files below them
 *   GET    /files?watch             change stream (Server-Sent Events), one
 *                                   `data: {…}` per committed change:
 *                                   {"op":"write"|"delete","node","path",…} for
 *                                   files, {"op":"node","change","id"} for nodes
 *   GET    /files/<path>            file bytes, Content-Type = file mime (binary
 *                                   files: a 302 to a signed store link
 *                                   when S3_PUBLIC_URL is set)
 *   GET    /files/<path>?versions   version history (JSON)
 *   PUT    /files/<path>            create or replace; body = bytes,
 *                                   Content-Type = mime (optional).
 *                                   `If-None-Match: *` only creates (412 when
 *                                   the file exists); `X-Read-Only: true`
 *                                   makes a new file read-only
 *   PUT    /files/<path>?propose    propose that content instead, for an
 *                                   editor to accept (see /proposals); a
 *                                   viewer may propose too. ?note= says why
 *   PATCH  /files/<path>            {path} → rename (move within the same
 *                                   place); 412 when the new path is taken
 *   DELETE /files/<path>            soft delete
 *
 *   Read-only files answer 403 to PUT, PATCH and DELETE, and carry
 *   `X-File-Read-Only: true` on GET.
 *
 *   Every /files route takes ?node=<id> for that knowledge node's files, or
 *   ?experiment=<id> for an experiment's; without either, files at the
 *   workspace root. File events carry "experiment" for an experiment's files.
 *
 *   GET    /nodes                   {types, rootRole, nodes}: the levels, your
 *                                   role at the root, and the nodes you can see
 *                                   (each with your role; null = shown only as
 *                                   the path to something you can see)
 *   POST   /nodes                   {parentId|null, name} → the new node (its
 *                                   type is the level below the parent's)
 *   GET    /nodes/<id>              {node, lineage}: lineage is top level first
 *   PATCH  /nodes/<id>              {name} → rename
 *   DELETE /nodes/<id>              soft delete, with everything below it
 *
 *   GET    /experiments?node=<id>   {experiments}: the ones you can see, on
 *                                   that node (node=root: at the workspace
 *                                   root) or (without node) anywhere, each
 *                                   with your access: writer (its author) or reader
 *   POST   /experiments             {nodeId|null, title, hypothesis?, params?,
 *                                   results?, state?} → a new draft: on a node
 *                                   with a copy of the node's files, at the
 *                                   root (null) empty. A run is an experiment
 *                                   with a report.md.
 *   POST   /experiments/from-folder {nodeId|null, folder, title?} →
 *                                   {experiment, moved}: moves a folder's files
 *                                   into a new draft (editor of the place)
 *   GET    /experiments/<id>        one experiment
 *   PATCH  /experiments/<id>        {title?, hypothesis?, params?, results?,
 *                                   status?: draft|shared|archived,
 *                                   state?: ready|running|done|failed}
 *   DELETE /experiments/<id>        soft delete, with its files
 *   Changes arrive on the /files change stream as
 *   {"op":"experiment","change","id","node"}.
 *
 *   GET    /search?q=<text>         {results}: files you can read whose text
 *                                   or path matches, best first, each with
 *                                   path, node, experiment, where (node names
 *                                   from the top), the matching snippet and
 *                                   match: "words", or "meaning" for a passage
 *                                   only close in meaning (semantic.ts).
 *                                   &scope=<node id> searches only that node,
 *                                   the nodes below it and their experiments;
 *                                   &near=<node id> or &experiment=<id> ranks
 *                                   files near there first; &limit= (≤ 50)
 *
 *   GET    /proposals               {proposals}: open proposed versions of
 *                                   files you can read, and your own, newest
 *                                   first; ?node=<id> one node's (root for
 *                                   the workspace root), ?experiment=<id> those
 *                                   promoted from it, ?status=open|accepted|
 *                                   rejected|withdrawn|all
 *   POST   /proposals               {experimentId, paths?, note?} → {proposals}:
 *                                   promote an experiment's changed files (all,
 *                                   or those paths) to its node
 *   GET    /proposals/promotable?experiment=<id>
 *                                   {files}: what promoting it would propose
 *   GET    /proposals/<id>          one proposal
 *   GET    /proposals/<id>/content  the proposed bytes
 *   POST   /proposals/<id>/accept   write it as the file's next version
 *                                   (credited to its proposer); editor
 *   POST   /proposals/<id>/reject   editor
 *   POST   /proposals/<id>/withdraw its proposer
 *   Changes arrive on the /files change stream as
 *   {"op":"proposal","change","id","node","path","author","authorId"}.
 *
 *   GET    /chats                   {threads, nextCursor}: your chats, most
 *                                   recently active first; ?agent=<id>,
 *                                   &archived (include archived ones),
 *                                   &limit= (≤ 200), &cursor=<nextCursor>
 *   GET    /chats/<id>              {chat, messages}: one of your chats and its
 *                                   messages as of its latest run
 *   GET    /chats/<id>/runs         {runs}: its runs' AG-UI events, in order
 *   POST   /chats/<id>/runs         {agentId, runId, parentRunId?, events,
 *                                   messages, name?} → the chat: saves a
 *                                   finished run, starting the chat on its
 *                                   first; 403 when the id is someone else's
 *   PATCH  /chats/<id>              {name?, archived?}
 *   DELETE /chats/<id>              for good, with its runs
 *   Chats are their user's alone (017_chats.sql): workspace owners don't see
 *   them, and storage tokens can't reach them.
 *
 *   GET    /access                  {me, rootRole}
 *   GET    /access/users            everyone who has signed in
 *   GET    /access/people           the same, with sign-up and last-active
 *                                   times, workspace role and groups
 *                                   (workspace owners only; for the admin panel)
 *   GET    /access/groups           the org tree, with direct members
 *   POST   /access/groups           {parentId|null, name}
 *   PATCH  /access/groups/<id>      {name}
 *   DELETE /access/groups/<id>      with its sub-groups
 *   PUT    /access/groups/<id>/members/<userId>    add a member
 *   DELETE /access/groups/<id>/members/<userId>    remove one
 *   GET    /access/grants?node=<id> grants on a node (no node = workspace)
 *   POST   /access/grants           {node|null, principalType: "user"|"group",
 *                                   principalId, role: viewer|editor|owner}
 *   DELETE /access/grants/<id>
 *   GET    /access/audit?limit=&kind=  recent changes, newest first; kind
 *                                   (repeatable) keeps e.g. only group.* and grant.*
 *
 * Reading needs viewer, changing files and nodes editor, deleting a node or
 * managing grants on it owner (of that node or one above it; whoever adds a
 * node owns it), and managing
 * groups owner of the workspace. Viewers may fork a node into an experiment;
 * a draft is seen by its author only, a shared or archived one by everyone
 * who can view the node, and only its author changes it. Who is asking comes from identity.ts: the
 * local user without AUTH_SECRET, the signed-in user with it.
 *
 * An X-Knowledge-Storage token (shared/identity-token.ts) instead is Claude
 * acting for its user through an outside service (an MCP server, a remote
 * backend), with that user's access and the same limits as this agent's own
 * file tools (tools.ts): in a knowledge node, and for skills at the root, it
 * writes with ?propose; it doesn't rename, delete, review proposals, share or
 * archive experiments, or manage access (agentRefusal, refusesStatus below).
 */

/** Why Claude, acting through a storage token, may not make this request; null when it may. */
export function agentRefusal(method: string, url: URL): string | null {
  const [section, ...rest] = url.pathname.split("/").slice(1);
  const sub = rest.join("/");
  if (section === "chats") return "Chat history stays with its user: storage tokens can't reach it";
  if (method === "GET" || method === "HEAD") {
    return section === "access" && sub !== "" ? "Claude doesn't manage access" : null;
  }
  switch (section) {
    case "files": {
      if (method !== "PUT") return "Claude doesn't rename or delete files";
      if (url.searchParams.has("propose") || url.searchParams.get("experiment")) return null;
      if (url.searchParams.get("node")) {
        return "Claude's writes in a knowledge node are proposals: add ?propose";
      }
      try {
        const skill = kindForPath(normalizePath(sub.split("/").map(decodeURIComponent).join("/"))) === "skill";
        return skill ? "Claude's changes to skills are proposals: add ?propose" : null;
      } catch {
        return null; // the file route answers bad paths itself
      }
    }
    case "nodes":
      return method === "POST" && sub === "" ? null : "Claude doesn't rename or delete nodes";
    case "experiments":
      if (method === "POST" && sub === "") return null;
      if (method === "PATCH" && sub !== "" && !sub.includes("/")) return null;
      return "Claude doesn't delete experiments or move folders into them";
    case "proposals":
      return method === "POST" && sub === "" ? null : "Claude doesn't accept, reject or withdraw proposals";
    case "access":
      return "Claude doesn't manage access";
    default:
      return "Claude can't do that with a storage token";
  }
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function watch(res: ServerResponse, events: EventHub, session: Session) {
  // Subscribe before answering, so a failure still gets a normal error response.
  // Events reach this connection in order, each once the previous was checked.
  let queue = Promise.resolve();
  const unsubscribe = await events.subscribe((event: WorkspaceEvent) => {
    queue = queue
      .then(async () => {
        if (await session.canSee(event)) res.write(`data: ${JSON.stringify(event)}\n\n`);
      })
      .catch((err) => console.error("[storage] watch:", err));
  });
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  // A comment line first so proxies flush headers, then a heartbeat so idle
  // connections are not cut.
  res.write(": watching\n\n");
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000);
  res.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

async function readBody(req: IncomingMessage, limit: number): Promise<Uint8Array | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) return null;
    chunks.push(chunk as Buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const bytes = await readBody(req, 64 * 1024);
  if (!bytes) return null;
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const optionalId = (value: unknown) =>
  value === null || value === undefined ? null : typeof value === "string" ? value : undefined;

async function handleNodes(req: IncomingMessage, res: ServerResponse, url: URL, session: Session) {
  const id = decodeURIComponent(url.pathname.replace(/^\/nodes\/?/, ""));
  if (!id) {
    if (req.method === "GET") {
      json(res, 200, await session.tree());
    } else if (req.method === "POST") {
      const body = await readJson(req);
      const parentId = optionalId(body?.parentId);
      if (!body || typeof body.name !== "string" || parentId === undefined) {
        json(res, 400, { error: "Expected {parentId: string | null, name: string}" });
        return;
      }
      json(res, 201, await session.createNode(parentId, body.name));
    } else {
      json(res, 405, { error: "Method not allowed" });
    }
    return;
  }

  switch (req.method) {
    case "GET": {
      const lineage = await session.lineage(id);
      json(res, 200, { node: lineage[lineage.length - 1], lineage });
      return;
    }
    case "PATCH": {
      const body = await readJson(req);
      if (!body || typeof body.name !== "string") {
        json(res, 400, { error: "Expected {name: string}" });
        return;
      }
      const node = await session.renameNode(id, body.name);
      if (!node) json(res, 404, { error: "Node not found" });
      else json(res, 200, node);
      return;
    }
    case "DELETE": {
      if (await session.deleteNode(id)) json(res, 200, { deleted: id });
      else json(res, 404, { error: "Node not found" });
      return;
    }
    default:
      json(res, 405, { error: "Method not allowed" });
  }
}

/** The experiment fields in a request body; undefined when one has the wrong type. */
function experimentInput(body: Record<string, unknown>): ExperimentInput | undefined {
  const input: ExperimentInput = {};
  for (const key of ["title", "hypothesis", "status", "state"] as const) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== "string") return undefined;
    (input as Record<string, unknown>)[key] = body[key];
  }
  for (const key of ["params", "results"] as const) {
    if (body[key] !== undefined) input[key] = body[key] as Record<string, unknown>;
  }
  return input;
}

// Sharing or archiving an experiment changes who sees it: the user's call,
// not an outside service's, so storage tokens (principal.via) leave status alone.
const STATUS_REFUSED = "Claude doesn't share or archive experiments with a storage token: leave out status";
const refusesStatus = (session: Session, input: ExperimentInput) =>
  Boolean(session.principal.via) && input.status !== undefined && input.status !== "draft";

async function handleExperiments(req: IncomingMessage, res: ServerResponse, url: URL, session: Session) {
  const id = decodeURIComponent(url.pathname.replace(/^\/experiments\/?/, ""));
  const expected =
    "Expected {title?, hypothesis?: string, params?, results?: object, status?: draft|shared|archived, state?: ready|running|done|failed}";
  const place = (v: unknown): v is string | null => v === null || typeof v === "string";
  if (id === "from-folder") {
    if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });
    const body = await readJson(req);
    const input = body && experimentInput(body);
    if (!body || !place(body.nodeId) || typeof body.folder !== "string" || !input) {
      return json(res, 400, { error: "Expected {nodeId: string|null, folder: string, title?: string}" });
    }
    json(res, 201, await session.experimentFromFolder(body.nodeId, body.folder, input));
    return;
  }
  if (!id) {
    if (req.method === "GET") {
      const node = url.searchParams.get("node");
      json(res, 200, { experiments: await session.experiments(node === "root" ? null : node || undefined) });
    } else if (req.method === "POST") {
      const body = await readJson(req);
      const input = body && experimentInput(body);
      if (!body || !place(body.nodeId) || !input) {
        json(res, 400, { error: `Expected {nodeId: string|null, title: string, …}; ${expected}` });
        return;
      }
      if (refusesStatus(session, input)) return json(res, 403, { error: STATUS_REFUSED });
      json(res, 201, await session.createExperiment(body.nodeId, input));
    } else {
      json(res, 405, { error: "Method not allowed" });
    }
    return;
  }

  switch (req.method) {
    case "GET":
      json(res, 200, await session.experiment(id));
      return;
    case "PATCH": {
      const body = await readJson(req);
      const input = body && experimentInput(body);
      if (!input) {
        json(res, 400, { error: expected });
        return;
      }
      // Any status change: back to draft from archived would make it writable again.
      if (session.principal.via && input.status !== undefined) return json(res, 403, { error: STATUS_REFUSED });
      json(res, 200, await session.updateExperiment(id, input));
      return;
    }
    case "DELETE":
      if (await session.deleteExperiment(id)) json(res, 200, { deleted: id });
      else json(res, 404, { error: "Experiment not found" });
      return;
    default:
      json(res, 405, { error: "Method not allowed" });
  }
}

async function handleAccess(req: IncomingMessage, res: ServerResponse, url: URL, session: Session) {
  const parts = url.pathname.split("/").slice(2).map(decodeURIComponent); // after /access
  const [section, id, sub, subId] = parts;
  const method = req.method ?? "GET";
  const notFound = () => json(res, 404, { error: "Not found" });
  const done = (ok: boolean) => (ok ? json(res, 200, { ok: true }) : notFound());

  if (!section) {
    if (method !== "GET") return json(res, 405, { error: "Method not allowed" });
    const me = (await session.users()).find((u) => u.id === session.principal.userId) ?? null;
    return json(res, 200, { me, rootRole: await session.role(null) });
  }

  if (section === "users" && !id && method === "GET") {
    return json(res, 200, { users: await session.users() });
  }

  if (section === "people" && !id && method === "GET") {
    return json(res, 200, { people: await session.people() });
  }

  if (section === "groups") {
    if (!id) {
      if (method === "GET") return json(res, 200, { groups: await session.groups() });
      if (method === "POST") {
        const body = await readJson(req);
        const parentId = optionalId(body?.parentId);
        if (!body || typeof body.name !== "string" || parentId === undefined) {
          return json(res, 400, { error: "Expected {parentId: string | null, name: string}" });
        }
        return json(res, 201, { id: await session.createGroup(parentId, body.name) });
      }
    } else if (!sub) {
      if (method === "PATCH") {
        const body = await readJson(req);
        if (!body || typeof body.name !== "string") return json(res, 400, { error: "Expected {name: string}" });
        return done(await session.renameGroup(id, body.name));
      }
      if (method === "DELETE") return done(await session.deleteGroup(id));
    } else if (sub === "members" && subId && (method === "PUT" || method === "DELETE")) {
      return done(await session.setMember(id, subId, method === "PUT"));
    }
  }

  if (section === "grants") {
    if (!id && method === "GET") {
      return json(res, 200, { grants: await session.grants(url.searchParams.get("node") || null) });
    }
    if (!id && method === "POST") {
      const body = await readJson(req);
      const node = optionalId(body?.node);
      if (
        !body ||
        node === undefined ||
        (body.principalType !== "user" && body.principalType !== "group") ||
        typeof body.principalId !== "string" ||
        !ROLES.includes(body.role as Role)
      ) {
        return json(res, 400, {
          error: 'Expected {node: string | null, principalType: "user" | "group", principalId, role}',
        });
      }
      const grantId = await session.setGrant(node, body.principalType, body.principalId, body.role as Role);
      return json(res, 200, { id: grantId });
    }
    if (id && method === "DELETE") return done(await session.revoke(id));
  }

  if (section === "audit" && !id && method === "GET") {
    const limit = Number.parseInt(url.searchParams.get("limit") ?? "100", 10);
    const kinds = url.searchParams.getAll("kind").filter(Boolean);
    return json(res, 200, { entries: await session.auditLog(Number.isNaN(limit) ? 100 : limit, kinds) });
  }

  json(res, 404, { error: "Not found" });
}

const PROPOSAL_STATUSES = ["open", "accepted", "rejected", "withdrawn", "all"];
const DECISIONS: Decision[] = ["accept", "reject", "withdraw"];

async function handleProposals(req: IncomingMessage, res: ServerResponse, url: URL, session: Session) {
  const [id, action] = url.pathname.split("/").slice(2).map(decodeURIComponent); // after /proposals
  const method = req.method ?? "GET";

  if (!id) {
    if (method === "GET") {
      const node = url.searchParams.get("node");
      const status = url.searchParams.get("status") ?? "open";
      if (!PROPOSAL_STATUSES.includes(status)) {
        return json(res, 400, { error: `status must be one of ${PROPOSAL_STATUSES.join(", ")}` });
      }
      const proposals = await session.proposals({
        node: node === null ? undefined : node === "root" || node === "" ? null : node,
        experiment: url.searchParams.get("experiment") || undefined,
        status: status as ProposalStatus | "all",
      });
      return json(res, 200, { proposals });
    }
    if (method === "POST") {
      const body = await readJson(req);
      const paths = body?.paths;
      if (
        !body ||
        typeof body.experimentId !== "string" ||
        (paths !== undefined && (!Array.isArray(paths) || paths.some((p) => typeof p !== "string"))) ||
        (body.note !== undefined && typeof body.note !== "string")
      ) {
        return json(res, 400, { error: "Expected {experimentId: string, paths?: string[], note?: string}" });
      }
      const proposals = await session.promote(body.experimentId, paths as string[] | undefined, body.note as string | undefined);
      return json(res, 201, { proposals });
    }
    return json(res, 405, { error: "Method not allowed" });
  }

  if (id === "promotable" && !action) {
    if (method !== "GET") return json(res, 405, { error: "Method not allowed" });
    const experiment = url.searchParams.get("experiment");
    if (!experiment) return json(res, 400, { error: "Expected ?experiment=<id>" });
    return json(res, 200, { files: await session.promotable(experiment) });
  }

  if (!action) {
    if (method !== "GET") return json(res, 405, { error: "Method not allowed" });
    return json(res, 200, await session.proposal(id));
  }
  if (action === "content") {
    if (method !== "GET") return json(res, 405, { error: "Method not allowed" });
    const { proposal, bytes } = await session.proposalContent(id);
    res.writeHead(200, {
      "Content-Type": proposal.mime,
      "Content-Length": bytes.byteLength,
      "Cache-Control": "no-cache",
    });
    res.end(bytes);
    return;
  }
  if (DECISIONS.includes(action as Decision)) {
    if (method !== "POST") return json(res, 405, { error: "Method not allowed" });
    return json(res, 200, await session.decide(id, action as Decision));
  }
  json(res, 404, { error: "Not found" });
}

/** Chat runs carry tool results and attachments, so they may be large. */
const MAX_RUN_BYTES = 32 * 1024 * 1024;

async function handleChats(req: IncomingMessage, res: ServerResponse, url: URL, storage: Storage, principal: Principal) {
  const parts = url.pathname.split("/").slice(2); // after /chats
  let id: string | undefined;
  try {
    id = parts[0] ? decodeURIComponent(parts[0]) : undefined;
  } catch {
    return json(res, 400, { error: "Malformed chat id" });
  }
  const sub = parts.slice(1).join("/");
  const method = req.method ?? "GET";
  const { chats } = storage;
  const me = principal.userId;
  const notFound = () => json(res, 404, { error: "Chat not found" });

  if (!id) {
    if (method !== "GET") return json(res, 405, { error: "Method not allowed" });
    const limit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
    return json(
      res,
      200,
      await chats.list(me, {
        agentId: url.searchParams.get("agent") || undefined,
        includeArchived: url.searchParams.has("archived"),
        limit: Number.isNaN(limit) ? undefined : limit,
        cursor: url.searchParams.get("cursor"),
      }),
    );
  }

  if (sub === "runs") {
    if (method === "GET") {
      const runs = await chats.runs(me, id);
      return runs ? json(res, 200, { runs }) : notFound();
    }
    if (method !== "POST") return json(res, 405, { error: "Method not allowed" });
    const bytes = await readBody(req, MAX_RUN_BYTES);
    if (!bytes) return json(res, 413, { error: `A run may be at most ${MAX_RUN_BYTES} bytes` });
    let body: Record<string, unknown> | null = null;
    try {
      body = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    } catch {
      // answered below
    }
    const parent = body?.parentRunId;
    if (
      !body ||
      typeof body.agentId !== "string" ||
      typeof body.runId !== "string" ||
      !Array.isArray(body.events) ||
      !Array.isArray(body.messages) ||
      (parent !== undefined && parent !== null && typeof parent !== "string") ||
      (body.name !== undefined && body.name !== null && typeof body.name !== "string")
    ) {
      return json(res, 400, {
        error: "Expected {agentId, runId: string, parentRunId?: string, events, messages: array, name?: string}",
      });
    }
    const chat = await chats.appendRun(me, id, {
      agentId: body.agentId,
      runId: body.runId,
      parentRunId: parent as string | null | undefined,
      events: body.events,
      messages: body.messages,
      name: body.name as string | null | undefined,
    });
    return json(res, 201, chat);
  }
  if (sub) return json(res, 404, { error: "Not found" });

  switch (method) {
    case "GET": {
      const chat = await chats.get(me, id);
      return chat ? json(res, 200, chat) : notFound();
    }
    case "PATCH": {
      const body = await readJson(req);
      if (
        !body ||
        (body.name !== undefined && body.name !== null && typeof body.name !== "string") ||
        (body.archived !== undefined && typeof body.archived !== "boolean")
      ) {
        return json(res, 400, { error: "Expected {name?: string, archived?: boolean}" });
      }
      const chat = await chats.update(me, id, {
        name: body.name as string | null | undefined,
        archived: body.archived as boolean | undefined,
      });
      return chat ? json(res, 200, chat) : notFound();
    }
    case "DELETE":
      return (await chats.remove(me, id)) ? json(res, 200, { deleted: id }) : notFound();
    default:
      return json(res, 405, { error: "Method not allowed" });
  }
}

async function handleSearch(req: IncomingMessage, res: ServerResponse, url: URL, session: Session) {
  if (!/^\/search\/?$/.test(url.pathname)) {
    json(res, 404, { error: "Not found" });
    return;
  }
  if (req.method !== "GET") {
    json(res, 405, { error: "Method not allowed" });
    return;
  }
  const limit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  const results = await session.search({
    query: url.searchParams.get("q") ?? "",
    scope: url.searchParams.get("scope") || null,
    near: url.searchParams.get("near") || null,
    nearExperiment: url.searchParams.get("experiment") || null,
    limit: Number.isNaN(limit) ? undefined : limit,
  });
  json(res, 200, { results });
}

export function createStorageHandler(
  storage: () => Storage | null,
  maxUploadBytes: number,
  state: () => StorageState = () => "ready",
) {
  return async function handleStorage(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
    const current = storage();
    if (!current) {
      // The UI tells these apart: 503 means "try again shortly"; 404 and 500
      // mean no server storage this session, so it keeps files in the browser.
      const now = state();
      if (now === "starting") json(res, 503, { error: "File storage is starting" });
      else if (now === "failed") json(res, 500, { error: "File storage failed to start" });
      else json(res, 404, { error: "File storage is not configured (set DATABASE_URL)" });
      return;
    }

    try {
      const principal = await identify(req, current, "user", { storageTokens: true });
      if (!principal) {
        json(res, 401, { error: "Sign in to use the workspace" });
        return;
      }
      if (principal.via) {
        const refusal = agentRefusal(req.method ?? "GET", url);
        if (refusal) {
          json(res, 403, { error: refusal });
          return;
        }
      }
      if (/^\/chats(\/|$)/.test(url.pathname)) return await handleChats(req, res, url, current, principal);
      const session = current.session(principal);
      if (/^\/nodes(\/|$)/.test(url.pathname)) await handleNodes(req, res, url, session);
      else if (/^\/access(\/|$)/.test(url.pathname)) await handleAccess(req, res, url, session);
      else if (/^\/experiments(\/|$)/.test(url.pathname)) await handleExperiments(req, res, url, session);
      else if (/^\/search(\/|$)/.test(url.pathname)) await handleSearch(req, res, url, session);
      else if (/^\/proposals(\/|$)/.test(url.pathname)) await handleProposals(req, res, url, session);
      else await handleFiles(req, res, url, current, session);
    } catch (err) {
      if (err instanceof NodeNotFoundError) {
        json(res, 404, { error: err.message });
        return;
      }
      if (err instanceof ForbiddenError || err instanceof ChatTakenError) {
        json(res, 403, { error: err.message });
        return;
      }
      if (err instanceof ReadOnlyFileError) {
        json(res, 403, { error: err.message, readOnly: true });
        return;
      }
      if (err instanceof FileExistsError) {
        json(res, 412, { error: err.message, exists: true });
        return;
      }
      if (
        err instanceof InvalidPathError ||
        err instanceof NodeError ||
        err instanceof AccessError ||
        err instanceof ExperimentError ||
        err instanceof SearchError ||
        err instanceof ProposalError ||
        err instanceof ChatError
      ) {
        json(res, 400, { error: err.message });
        return;
      }
      console.error("[storage] request failed:", err);
      json(res, 500, { error: "Storage error" });
    }
  };

  async function handleFiles(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    current: Storage,
    session: Session,
  ): Promise<void> {
    const rest = url.pathname.replace(/^\/files\/?/, "");
    let path: string;
    try {
      path = rest.split("/").map(decodeURIComponent).join("/");
    } catch {
      json(res, 400, { error: "Malformed path encoding" });
      return;
    }

    if (path === "" && req.method === "GET" && url.searchParams.has("watch")) {
      await watch(res, current.events, session);
      return;
    }

    const experiment = url.searchParams.get("experiment");
    const service = experiment
      ? await session.experimentFiles(experiment)
      : await session.files(url.searchParams.get("node") || null);

    if (path === "") {
      if (req.method !== "GET") return json(res, 405, { error: "Method not allowed" });
      const depth = url.searchParams.get("depth");
      const dir = url.searchParams.get("dir");
      if (depth === null && dir === null) return json(res, 200, { files: await service.list() });
      if (depth !== null && !/^[1-9]\d*$/.test(depth)) {
        return json(res, 400, { error: "depth must be a whole number of at least 1" });
      }
      const folder = dir?.replace(/\/+$/, "") ? normalizePath(dir.replace(/\/+$/, "")) : "";
      json(res, 200, listLevel(await service.list(), folder, depth === null ? undefined : Number(depth)));
      return;
    }

    switch (req.method) {
      case "GET": {
        if (url.searchParams.has("versions")) {
          const versions = await service.history(path);
          if (!versions) json(res, 404, { error: "Not found" });
          else json(res, 200, { versions });
          return;
        }
        // Binary files come straight from the object store when it is reachable
        // from browsers: a short-lived link, made after the access check above.
        // Text stays here, since the UI fetches it from this origin.
        const info = await service.stat(path);
        if (info && !isTextFile(info.path, info.mime)) {
          const link = await current.blobs.downloadUrl(info.sha256, {
            mime: info.mime,
            filename: info.path.split("/").pop() ?? info.path,
          });
          if (link) {
            res.writeHead(302, { Location: link, "Cache-Control": "no-store" });
            res.end();
            return;
          }
        }
        const file = info && (await service.read(path));
        if (!file) {
          json(res, 404, { error: "Not found" });
          return;
        }
        const etag = `"${file.info.sha256}"`;
        if (req.headers["if-none-match"] === etag) {
          res.writeHead(304, { ETag: etag });
          res.end();
          return;
        }
        res.writeHead(200, {
          "Content-Type": file.info.mime,
          "Content-Length": file.bytes.byteLength,
          ETag: etag,
          "Last-Modified": new Date(file.info.updatedAt).toUTCString(),
          "X-File-Author": file.info.author,
          ...(file.info.readOnly ? { "X-File-Read-Only": "true" } : {}),
          "Cache-Control": "no-cache",
        });
        res.end(file.bytes);
        return;
      }
      case "PUT": {
        const bytes = await readBody(req, maxUploadBytes);
        if (!bytes) {
          json(res, 413, { error: `File exceeds ${maxUploadBytes} bytes` });
          return;
        }
        const header = req.headers["content-type"]?.split(";")[0].trim();
        const mime = header && header !== "application/octet-stream" ? header : undefined;
        if (url.searchParams.has("propose")) {
          if (experiment) {
            json(res, 400, { error: "An experiment's files change directly; promote it to propose them" });
            return;
          }
          const note = url.searchParams.get("note") ?? undefined;
          json(res, 201, await session.propose(service.nodeId, path, bytes, { mime, note }));
          return;
        }
        const info = await service.write(path, bytes, {
          mime,
          createOnly: req.headers["if-none-match"]?.trim() === "*",
          readOnly: String(req.headers["x-read-only"] ?? "").trim().toLowerCase() === "true",
        });
        json(res, 200, info);
        return;
      }
      case "PATCH": {
        const body = await readJson(req);
        if (!body || typeof body.path !== "string") {
          json(res, 400, { error: "Expected {path: string}" });
          return;
        }
        const info = await service.rename(path, body.path);
        if (!info) json(res, 404, { error: "Not found" });
        else json(res, 200, info);
        return;
      }
      case "DELETE": {
        if (await service.remove(path)) json(res, 200, { deleted: path });
        else json(res, 404, { error: "Not found" });
        return;
      }
      default:
        json(res, 405, { error: "Method not allowed" });
    }
  }
}
