/**
 * Storage API conformance (issue #169, step 2): drives every operation in
 * openapi/storage.yaml over HTTP against a running backend and checks each answer
 * against the spec: the status code is documented, JSON bodies validate against
 * the response schema, and no field is missing from the spec. Any backend that
 * claims to serve the storage API (the TypeScript agent today, a Python service
 * later) must pass it.
 *
 * Needs STORAGE_URL (the backend's base URL) and AUTH_SECRET (the backend's
 * secret, to sign the test users' identity tokens). The backend must use a fresh
 * database: the first user to sign in becomes the workspace owner, and the suite
 * relies on that being its own user. `pnpm -C apps/agent test:conformance` starts
 * the agent on the test database and runs this file.
 *
 * With CONFORMANCE_SAMPLES set to a file path, every JSON answer that matched the
 * spec, and every JSON request that succeeded, is written there as one JSON line
 * ({operationId, status, response} or {operationId, request}), so the Python
 * models (packages/knowledge-py) can be checked against real traffic.
 */
import assert from "node:assert/strict";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { describe, test } from "node:test";

import { Ajv2020, type AnySchema } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import YAML from "yaml";

import type { components } from "../src/generated/storage-api";
import { signIdentityToken } from "../src/identity-token";

type Schema = components["schemas"];
type Json = Record<string, unknown>;
type SchemaObject = {
  $ref?: string;
  properties?: Record<string, SchemaObject>;
  additionalProperties?: unknown;
  allOf?: SchemaObject[];
  oneOf?: SchemaObject[];
  items?: SchemaObject;
};
type Operation = { operationId: string; responses: Record<string, unknown> };
type Response = { content?: Record<string, { schema?: SchemaObject }> };
type Spec = { paths: Record<string, Record<string, Operation>>; components: Record<string, unknown> };

const BASE = process.env.STORAGE_URL?.replace(/\/$/, "");
const SECRET = process.env.AUTH_SECRET;
const SAMPLES = process.env.CONFORMANCE_SAMPLES;
if (SAMPLES) writeFileSync(SAMPLES, "");
const sample = (line: Record<string, unknown>) => SAMPLES && appendFileSync(SAMPLES, JSON.stringify(line) + "\n");
const METHODS = ["get", "put", "post", "patch", "delete"];

// Refs become "spec#/components/..." so Ajv resolves them against one shared schema.
const specText = readFileSync(new URL("../openapi/storage.yaml", import.meta.url), "utf8");
const spec = YAML.parse(specText.replaceAll('"#/components/', '"spec#/components/')) as Spec;

// ajv-formats is CommonJS; under ESM its default export may be wrapped once more.
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ?? addFormatsModule) as (ajv: Ajv2020) => void;
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ $id: "spec", components: spec.components });

const templates = Object.keys(spec.paths).map((template) => ({
  template,
  // {path} takes the rest of the URL path (files in folders); other parameters one segment.
  re: new RegExp("^" + template.replace("{path}", "(.+)").replace(/\{[^}]+\}/g, "[^/]+") + "$"),
  specificity: template.split("/").filter((s) => !s.startsWith("{")).length,
}));

/** Every operation/status pair that answered, for the coverage test at the end. */
const covered = new Set<string>();
/** What the running test found wrong; each test starts with an empty list. */
let problems: string[] = [];

function resolve<T>(node: unknown): T {
  let current = node as { $ref?: string } | undefined;
  while (current?.$ref) {
    const parts = current.$ref.replace("spec#/", "").split("/");
    current = parts.reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], spec) as { $ref?: string };
  }
  return current as T;
}

/** The properties a schema allows for this value, and whether it allows others too. */
function keysOf(node: SchemaObject, data: unknown): { props: Record<string, SchemaObject>; open: boolean } {
  const schema = resolve<SchemaObject>(node);
  let props = { ...(schema.properties ?? {}) };
  let open = schema.additionalProperties === true || (!schema.properties && !schema.allOf && !schema.oneOf);
  for (const part of schema.allOf ?? []) {
    const k = keysOf(part, data);
    props = { ...props, ...k.props };
    open ||= k.open;
  }
  for (const branch of schema.oneOf ?? []) {
    if (!ajv.validate(branch as AnySchema, data)) continue;
    const k = keysOf(branch, data);
    props = { ...props, ...k.props };
    open ||= k.open;
    break;
  }
  return { props, open };
}

/** Fields in the answer that the spec doesn't mention (a backend answering more than documented). */
function undocumented(node: SchemaObject, data: unknown, at: string): string[] {
  const schema = resolve<SchemaObject>(node);
  if (Array.isArray(data)) return schema.items ? data.flatMap((d, i) => undocumented(schema.items!, d, `${at}[${i}]`)) : [];
  if (!data || typeof data !== "object") return [];
  const { props, open } = keysOf(schema, data);
  if (open) return [];
  return Object.entries(data).flatMap(([k, v]) => (props[k] ? undocumented(props[k], v, `${at}.${k}`) : [`${at}.${k}`]));
}

/** Checks an answer against one named schema, undocumented fields included. */
function validates(ref: string, data: unknown, label: string): void {
  const schema = { $ref: `spec#/components/schemas/${ref}` };
  const validate = ajv.compile(schema);
  if (!validate(data)) problems.push(`${label}: not a ${ref}: ${ajv.errorsText(validate.errors)}`);
  else for (const extra of undocumented(schema, data, "")) problems.push(`${label}: field not in the ${ref} schema: ${extra}`);
}

const now = () => Math.floor(Date.now() / 1000);
const user = (sub: string, name: string) => ({
  "X-Knowledge-User": signIdentityToken({ sub, name, email: `${name}@example.com`, exp: now() + 600 }, SECRET!),
});
const memoryToken = (sub: string, thread: string) => ({
  "X-Knowledge-Memory": signIdentityToken({ sub, exp: now() + 600, aud: "memory", via: "mcp:conformance", thread }, SECRET!),
});
const storageToken = (sub: string) => ({
  "X-Knowledge-Storage": signIdentityToken({ sub, exp: now() + 600, aud: "storage", via: "mcp:conformance" }, SECRET!),
});

type CallOptions = { headers?: Record<string, string>; json?: unknown; body?: BodyInit; expect?: number };

/** One request: checks the status is the expected one and the answer matches the spec. */
async function call<T = Json>(method: string, path: string, opts: CallOptions = {}) {
  // AG-UI streams answer in protobuf to Accept: */*; ask for the SSE form the app uses.
  const headers: Record<string, string> = { Accept: "application/json, text/event-stream", ...opts.headers };
  let body = opts.body;
  if (opts.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.json);
  }
  const res = await fetch(BASE + path, { method, headers, body, redirect: "manual" });
  const url = new URL(BASE + path);
  const text = await res.text();
  const label = `${method} ${path} -> ${res.status}`;
  const result = { res, text, data: null as T };
  if (opts.expect !== undefined && res.status !== opts.expect) problems.push(`${label}: expected ${opts.expect}: ${text.slice(0, 200)}`);

  const match = templates.filter((x) => x.re.test(url.pathname)).sort((a, b) => b.specificity - a.specificity)[0];
  if (!match) return problems.push(`${label}: no path in the spec`), result;
  const op = spec.paths[match.template][method.toLowerCase()];
  if (!op) return problems.push(`${label}: no ${method} for ${match.template} in the spec`), result;
  covered.add(`${op.operationId} ${res.status}`);
  const response = resolve<Response | undefined>(op.responses[String(res.status)]);
  if (!response) return problems.push(`${label}: status not in the spec for ${op.operationId}: ${text.slice(0, 200)}`), result;

  const type = (res.headers.get("content-type") ?? "").split(";")[0];
  if (res.ok && opts.json !== undefined) sample({ operationId: op.operationId, request: opts.json });
  if (type === "application/json") {
    result.data = JSON.parse(text) as T;
    const schema = response.content?.["application/json"]?.schema;
    if (!schema) problems.push(`${label}: JSON answer, but the spec has no JSON schema for it`);
    else {
      const validate = ajv.compile(schema as AnySchema);
      if (!validate(result.data)) problems.push(`${label} (${op.operationId}): ${ajv.errorsText(validate.errors)}\n   ${text.slice(0, 300)}`);
      else {
        const extras = undocumented(schema, result.data, "");
        for (const extra of extras) problems.push(`${label} (${op.operationId}): field not in the spec: ${extra}`);
        if (!extras.length) sample({ operationId: op.operationId, status: res.status, response: result.data });
      }
      // A file read with ?versions is the history, not just any JSON.
      if (op.operationId === "readFile" && url.searchParams.has("versions")) validates("VersionList", result.data, label);
    }
  } else if (response.content && !response.content[type] && !response.content["*/*"]) {
    problems.push(`${label}: content-type ${type || "(none)"} not in the spec`);
  }
  return result;
}

/** The JSON of each `data:` line of a Server-Sent Events body. */
function sseData(text: string): unknown[] {
  return [...text.matchAll(/^data: (.*)$/gm)].map((m) => JSON.parse(m[1]));
}

/** A test that fails with the list of everything that didn't match the spec. */
function step(name: string, fn: () => Promise<void>) {
  test(name, async () => {
    problems = [];
    try {
      await fn();
    } catch (err) {
      // Show what went wrong before the step gave up (often the cause).
      if (problems.length) (err as Error).message += `\nanswers that didn't match before this:\n- ${problems.join("\n- ")}`;
      throw err;
    }
    assert.deepEqual(problems, [], `${problems.length} answer(s) don't match the spec:\n- ${problems.join("\n- ")}`);
  });
}

describe("storage API conformance", { skip: !(BASE && SECRET) && "STORAGE_URL and AUTH_SECRET not set" }, () => {
  const alice = user("conformance|alice", "alice");
  const bob = user("conformance|bob", "bob");
  const stamp = Date.now();
  let bobId = "";
  let tech: Schema["KnowledgeNode"];
  let mod: Schema["KnowledgeNode"];
  let grant: Schema["Grant"];
  let q = "";
  let exp: Schema["Experiment"];

  step("identity and access", async () => {
    await call("GET", "/nodes", { expect: 401 });
    const me = await call<{ rootRole: string | null }>("GET", "/access", { headers: alice, expect: 200 });
    assert.equal(me.data?.rootRole, "owner", "the first user must become the workspace owner: run against a fresh database");
    await call("GET", "/access", { headers: bob, expect: 200 });
    await call("GET", "/access/people", { headers: alice, expect: 200 });
    await call("GET", "/access/people", { headers: bob, expect: 403 });
    const users = await call<{ users: Schema["User"][] }>("GET", "/access/users", { headers: alice, expect: 200 });
    bobId = users.data.users.find((u) => u.subject === "conformance|bob")!.id;
  });

  step("knowledge nodes", async () => {
    tech = (await call<Schema["KnowledgeNode"]>("POST", "/nodes", { headers: alice, json: { parentId: null, name: `Tech ${stamp}` }, expect: 201 })).data;
    mod = (await call<Schema["KnowledgeNode"]>("POST", "/nodes", { headers: alice, json: { parentId: tech.id, name: "Module" }, expect: 201 })).data;
    q = `?node=${mod.id}`;
    await call("POST", "/nodes", { headers: alice, json: { name: 1 }, expect: 400 });
    await call("GET", "/nodes", { headers: alice, expect: 200 });
    await call("GET", `/nodes/${mod.id}`, { headers: alice, expect: 200 });
    await call("PATCH", `/nodes/${mod.id}`, { headers: alice, json: { name: "Module X" }, expect: 200 });
    await call("GET", "/nodes/00000000-0000-0000-0000-000000000000", { headers: alice, expect: 404 });
  });

  step("grants", async () => {
    grant = (await call<Schema["Grant"]>("POST", "/access/grants", { headers: alice, json: { node: tech.id, principalType: "user", principalId: bobId, role: "viewer" }, expect: 200 })).data;
    await call("GET", `/access/grants?node=${tech.id}`, { headers: alice, expect: 200 });
    await call("GET", "/access/grants", { headers: alice, expect: 200 });
    await call("GET", "/nodes", { headers: bob, expect: 200 });
  });

  step("files", async () => {
    await call("PUT", `/files/notes/a.md${q}`, { headers: { ...alice, "Content-Type": "text/markdown" }, body: "# A\nhello conformance", expect: 200 });
    await call("PUT", `/files/notes/a.md${q}`, { headers: { ...alice, "If-None-Match": "*" }, body: "again", expect: 412 });
    await call("PUT", `/files/uploads/pic.bin${q}`, { headers: { ...alice, "Content-Type": "application/octet-stream" }, body: new Uint8Array([0, 1, 2, 255]), expect: 200 });
    await call("GET", `/files${q}`, { headers: alice, expect: 200 });
    const read = await call("GET", `/files/notes/a.md${q}`, { headers: alice, expect: 200 });
    assert.equal(read.text, "# A\nhello conformance");
    await call("GET", `/files/notes/a.md${q}`, { headers: { ...alice, "If-None-Match": read.res.headers.get("etag")! }, expect: 304 });
    // 200 with the bytes, or 302 to the object store when S3_PUBLIC_URL is set.
    await call("GET", `/files/uploads/pic.bin${q}`, { headers: alice });
    await call("GET", `/files/notes/a.md${q}&versions`, { headers: alice, expect: 200 });
    await call("PUT", `/files/notes/data.json${q}`, { headers: { ...alice, "Content-Type": "application/json" }, body: '{"temperature":60}', expect: 200 });
    await call("GET", `/files/notes/data.json${q}`, { headers: alice, expect: 200 });
    await call("GET", `/files/notes/data.json${q}&versions`, { headers: alice, expect: 200 });
    await call("GET", `/files/notes/missing.md${q}`, { headers: alice, expect: 404 });
    await call("PUT", `/files/notes/b.md${q}`, { headers: alice, body: "b", expect: 200 });
    await call("PATCH", `/files/notes/b.md${q}`, { headers: alice, json: { path: "notes/a.md" }, expect: 412 });
    await call("PATCH", `/files/notes/b.md${q}`, { headers: alice, json: { path: "notes/c.md" }, expect: 200 });
    await call("PATCH", `/files/notes/c.md${q}`, { headers: alice, json: {}, expect: 400 });
    await call("DELETE", `/files/notes/c.md${q}`, { headers: alice, expect: 200 });
    // Bob only views here: the role decides, for every change to a file.
    await call("PUT", `/files/notes/a.md${q}`, { headers: bob, body: "bob edit", expect: 403 });
    await call("PATCH", `/files/notes/a.md${q}`, { headers: bob, json: { path: "notes/bob.md" }, expect: 403 });
    await call("DELETE", `/files/notes/a.md${q}`, { headers: bob, expect: 403 });
    await call("PUT", "/files/notes/root.md", { headers: alice, body: "root note", expect: 200 });
    await call("GET", "/files", { headers: alice, expect: 200 });
    await call("PUT", "/files/..%2Fx.md", { headers: alice, body: "x", expect: 400 });
  });

  step("proposals by a viewer, then decisions", async () => {
    const propose = (path: string, body: string) => call<Schema["Proposal"]>("PUT", `/files/${path}${q}&propose&note=typo`, { headers: bob, body, expect: 201 });
    const p1 = (await propose("notes/a.md", "# A\nfixed")).data;
    const p2 = (await propose("notes/new.md", "new")).data;
    const p3 = (await propose("notes/other.md", "other")).data;
    await call("GET", "/proposals", { headers: alice, expect: 200 });
    await call("GET", `/proposals?node=${mod.id}&status=all`, { headers: alice, expect: 200 });
    await call("GET", "/proposals?status=nope", { headers: alice, expect: 400 });
    await call("GET", `/proposals/${p1.id}`, { headers: alice, expect: 200 });
    await call("GET", `/proposals/${p1.id}/content`, { headers: alice, expect: 200 });
    await call("POST", `/proposals/${p1.id}/accept`, { headers: bob, expect: 403 });
    await call("POST", `/proposals/${p1.id}/accept`, { headers: alice, expect: 200 });
    await call("POST", `/proposals/${p2.id}/reject`, { headers: alice, expect: 200 });
    await call("POST", `/proposals/${p3.id}/withdraw`, { headers: bob, expect: 200 });
  });

  step("storage tokens can read but not write or see chats", async () => {
    const token = storageToken("conformance|alice");
    await call("GET", `/files${q}`, { headers: token, expect: 200 });
    await call("PUT", `/files/notes/a.md${q}`, { headers: token, body: "x", expect: 403 });
    await call("GET", "/chats", { headers: token, expect: 403 });
  });

  step("experiments", async () => {
    exp = (await call<Schema["Experiment"]>("POST", "/experiments", { headers: alice, json: { nodeId: mod.id, title: "Try it", hypothesis: "h", params: { a: 1 } }, expect: 201 })).data;
    const rootExp = (await call<Schema["Experiment"]>("POST", "/experiments", { headers: alice, json: { nodeId: null, title: "Root run" }, expect: 201 })).data;
    await call("POST", "/experiments", { headers: alice, json: { nodeId: mod.id, title: 3 }, expect: 400 });
    await call("GET", `/experiments?node=${mod.id}`, { headers: alice, expect: 200 });
    await call("GET", "/experiments?node=root", { headers: alice, expect: 200 });
    await call("GET", "/experiments", { headers: alice, expect: 200 });
    await call("GET", `/experiments/${exp.id}`, { headers: alice, expect: 200 });
    await call("PATCH", `/experiments/${exp.id}`, { headers: alice, json: { results: { ok: true }, state: "running" }, expect: 200 });
    await call("PATCH", `/experiments/${exp.id}`, { headers: storageToken("conformance|alice"), json: { status: "shared" }, expect: 403 });
    await call("PUT", `/files/notes/a.md?experiment=${exp.id}`, { headers: alice, body: "# A\nexperiment change", expect: 200 });
    await call("PUT", `/files/notes/added.md?experiment=${exp.id}`, { headers: alice, body: "added", expect: 200 });
    await call("GET", `/files?experiment=${exp.id}`, { headers: alice, expect: 200 });
    await call("POST", `/experiments/${rootExp.id}/inputs`, { headers: alice, json: { inputs: [{ path: "notes/a.md", node: mod.id }] }, expect: 200 });
    await call("POST", `/experiments/${rootExp.id}/inputs`, { headers: alice, json: { inputs: "x" }, expect: 400 });
    await call("GET", `/proposals/promotable?experiment=${exp.id}`, { headers: alice, expect: 200 });
    await call("GET", "/proposals/promotable", { headers: alice, expect: 400 });
    await call("POST", "/proposals", { headers: alice, json: { experimentId: exp.id, note: "promote" }, expect: 201 });
    await call("GET", `/proposals?experiment=${exp.id}`, { headers: alice, expect: 200 });
    await call("PATCH", `/experiments/${exp.id}`, { headers: alice, json: { status: "shared" }, expect: 200 });
  });

  step("runs", async () => {
    const token = storageToken("conformance|alice");
    const provenance = {
      chat: "chat-1", model: "claude-test", skill: { name: "analysis" }, startedBy: "forged",
      rerunOf: { id: "forged" }, finishedAt: "2000-01-01T00:00:00Z", extra: { kept: true },
    };
    const run = (await call<Schema["Experiment"]>("POST", "/experiments/runs", {
      headers: token,
      json: { nodeId: mod.id, title: "Run it", params: { a: 1 }, inputs: [{ path: "notes/a.md", node: mod.id }], provenance },
      expect: 201,
    })).data;
    assert.equal(run.state, "running");
    assert.equal(run.provenance.chat, "chat-1");
    // Who started it and what it read are the server's to record, not the caller's.
    assert.notEqual(run.provenance.startedBy, "forged");
    // The server's own keys aren't the caller's to set; others are kept.
    assert.equal(run.provenance.rerunOf, undefined);
    assert.equal(run.provenance.finishedAt, undefined);
    assert.deepEqual(run.provenance.extra, { kept: true });
    assert.deepEqual((run.provenance.inputs as { path: string }[]).map((i) => i.path), ["inputs/a.md"]);
    await call("GET", `/files/report.md?experiment=${run.id}`, { headers: alice, expect: 200 });
    await call("POST", "/experiments/runs", { headers: alice, json: { nodeId: mod.id }, expect: 400 });
    await call("POST", "/experiments/runs", { headers: alice, json: { nodeId: mod.id, title: "x", state: "done" }, expect: 400 });
    await call("POST", "/experiments/runs", { headers: alice, json: { nodeId: mod.id, title: "x", provenance: "x" }, expect: 400 });
    // Fields the run panel shows must have the shapes it reads.
    for (const bad of [{ model: { name: "x" } }, { skill: { sha256: 123 } }, { skill: "analysis" }, { tools: { a: 1 } }]) {
      await call("POST", "/experiments/runs", { headers: alice, json: { nodeId: mod.id, title: "x", provenance: bad }, expect: 400 });
    }
    await call("POST", `/experiments/${run.id}/finish`, { headers: alice, json: { results: "x" }, expect: 400 });
    const done = (await call<Schema["Experiment"]>("POST", `/experiments/${run.id}/finish`, { headers: token, json: { results: { ok: 1 } }, expect: 200 })).data;
    assert.equal(done.state, "done");
    await call("POST", `/experiments/${run.id}/finish`, { headers: alice, json: { results: { ok: 2 }, state: "failed" }, expect: 400 });
    const again = (await call<Schema["Experiment"]>("POST", "/experiments/runs", { headers: token, json: { rerunOf: run.id }, expect: 201 })).data;
    assert.equal(again.title, "Run it (rerun)");
    assert.deepEqual(again.provenance.rerunOf, { id: run.id });
  });

  step("experiment uploads", async () => {
    // Under the suite's own tree (deleted with it), adding a loop and a process named None.
    const id = crypto.randomUUID();
    const form = (meta: unknown, files: Record<string, string> = {}) => {
      const body = new FormData();
      body.append("meta", JSON.stringify(meta));
      for (const [path, text] of Object.entries(files)) body.append(path, new Blob([text], { type: "text/plain" }), path.split("/").pop());
      return body;
    };
    const path = `${tech.name}/Module X//`;
    const up = await call<Schema["ExperimentUpload"]>("POST", "/experiments/upload", {
      headers: alice,
      body: form({ id, path, title: "Uploaded", params: { a: 2 } }, { "report.md": "# Uploaded", "data/metrics.csv": "a,b\n1,2" }),
      expect: 201,
    });
    assert.equal(up.data.experiment.id, id);
    assert.deepEqual(up.data.created.map((n) => n.name), ["None", "None"]);
    await call("POST", "/experiments/upload", { headers: alice, body: form({ id, path, title: "Again" }), expect: 409 });
    await call("POST", "/experiments/upload", { headers: alice, body: form({ id: crypto.randomUUID(), path: tech.name, title: "Short" }), expect: 400 });
    await call("POST", "/experiments/upload", { headers: alice, json: { id, path, title: "JSON" }, expect: 415 });
    // Bob only views the tree: adding a process below it needs editor.
    await call("POST", "/experiments/upload", { headers: bob, body: form({ id: crypto.randomUUID(), path: `${tech.name}/Module X/None/Bob's`, title: "Bob" }), expect: 403 });
    await call("POST", "/experiments/upload", { headers: storageToken("conformance|alice"), body: form({ id: crypto.randomUUID(), path, title: "Token" }), expect: 403 });
  });

  step("search", async () => {
    await call("GET", "/search?q=conformance", { headers: alice, expect: 200 });
    await call("GET", `/search?q=hello&scope=${tech.id}&limit=5`, { headers: alice, expect: 200 });
  });

  step("watch streams a WorkspaceEvent after a write", async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${BASE}/files?watch`, { headers: alice, signal: ctrl.signal });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type")?.split(";")[0], "text/event-stream");
    covered.add(`listFiles ${res.status}`);
    const reader = res.body!.getReader();
    const events: string[] = [];
    const reading = (async () => {
      let buffer = "";
      while (!events.length) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += new TextDecoder().decode(value);
        for (const m of buffer.matchAll(/^data: (.*)$/gm)) events.push(m[1]);
      }
    })().catch(() => {});
    await new Promise((r) => setTimeout(r, 300));
    await call("PUT", `/files/notes/watched.md${q}`, { headers: alice, body: "w", expect: 200 });
    await Promise.race([reading, new Promise((r) => setTimeout(r, 5000))]);
    ctrl.abort();
    if (!events.length) problems.push("watch: no event arrived within 5 s of a write");
    for (const line of events) validates("WorkspaceEvent", JSON.parse(line), `watch event ${line}`);
  });

  step("memory: your own notes, the inbox and import", async () => {
    const thread = `conformance-memory-${stamp}`;
    await call("GET", "/memory", { expect: 401 });
    // Storage tokens reach only the storage routes.
    await call("GET", "/memory", { headers: storageToken("conformance|alice"), expect: 401 });
    await call("GET", "/memory", { headers: alice, expect: 200 });
    await call("GET", `/memory?thread=${thread}&node=${mod.id}`, { headers: alice, expect: 200 });
    await call("PUT", "/memory/settings", { headers: alice, json: { mode: "ask" }, expect: 200 });
    await call("PUT", "/memory/settings", { headers: alice, json: { mode: "on", thread: `${thread}-incognito`, incognito: true }, expect: 200 });
    await call("PUT", "/memory/settings", { headers: alice, json: { mode: "sometimes" }, expect: 400 });

    const note = { description: "How alice likes answers", type: "preference", body: "Short sentences." };
    await call("PUT", "/memory/notes/conformance-style?create=1", { headers: alice, json: note, expect: 200 });
    await call("PUT", "/memory/notes/conformance-style?create=1", { headers: alice, json: note, expect: 409 });
    await call("PUT", "/memory/notes/conformance-style", { headers: alice, json: { ...note, body: "Very short sentences." }, expect: 200 });
    await call("PUT", "/memory/notes/conformance-style", { headers: alice, json: { ...note, type: "mood" }, expect: 400 });
    await call("GET", "/memory/notes/conformance-style", { headers: alice, expect: 200 });
    await call("GET", "/memory/notes/no-such-note", { headers: alice, expect: 404 });
    await call("POST", "/memory/notes/conformance-style/restore", { headers: alice, json: { version: 1 }, expect: 200 });
    await call("POST", "/memory/notes/conformance-style/restore", { headers: alice, json: {}, expect: 400 });
    await call("POST", "/memory/notes/conformance-style/archive", { headers: alice, json: { archived: true }, expect: 200 });
    await call("POST", "/memory/notes/conformance-style/archive", { headers: alice, json: { archived: false }, expect: 200 });

    const exported = await call("GET", "/memory/export", { headers: alice, expect: 200 });
    assert.equal(exported.res.headers.get("content-type"), "application/zip");
    const zip = new Uint8Array(await (await fetch(`${BASE}/memory/export`, { headers: alice })).arrayBuffer());
    await call("POST", "/memory/import", { headers: { ...alice, "Content-Type": "application/zip" }, body: zip, expect: 200 });
    const text = (name: string) => `---\nname: ${name}\ndescription: Imported for the conformance suite\ntype: reference\n---\nA note.\n`;
    const imported = await call<Schema["MemoryImport"]>("POST", "/memory/import", { headers: alice, json: { text: text("conformance-kept") + text("conformance-dropped"), label: "suite" }, expect: 200 });
    assert.equal(imported.data.how, "files");
    await call("POST", "/memory/import", { headers: { ...alice, "Content-Type": "application/json" }, body: "{", expect: 400 });

    const overview = await call<Schema["MemoryOverview"]>("GET", "/memory", { headers: alice, expect: 200 });
    const waiting = (name: string) => overview.data.inbox.find((i) => i.name === name)!.id;
    await call("POST", `/memory/inbox/${waiting("conformance-kept")}/accept`, { headers: alice, expect: 200 });
    await call("POST", `/memory/inbox/${waiting("conformance-dropped")}/reject`, { headers: alice, expect: 200 });
    await call("POST", `/memory/inbox/${crypto.randomUUID()}/accept`, { headers: alice, expect: 404 });

    const activity = await call<{ activity: Schema["MemoryActivity"][] }>("GET", "/memory/activity", { headers: alice, expect: 200 });
    const change = activity.data.activity.find((a) => a.undoable)!;
    await call("POST", `/memory/events/${change.id}/undo`, { headers: alice, expect: 200 });
    // Undoing the accepted add removed the note, and its history with it.
    await call("POST", `/memory/events/${change.id}/undo`, { headers: alice, expect: 404 });
    await call("POST", `/memory/events/${crypto.randomUUID()}/undo`, { headers: alice, expect: 404 });

    // An outside MCP server with a memory token for one chat: its changes wait in the inbox.
    await call("GET", "/memory/agent", { expect: 401 });
    await call("GET", "/memory/agent", { headers: memoryToken("conformance|alice", thread), expect: 200 });
    await call("GET", "/memory/agent", { headers: memoryToken("conformance|alice", `${thread}-incognito`), expect: 403 });
    const agent = memoryToken("conformance|alice", thread);
    await call("POST", "/memory/agent/tools/memory_save", { headers: agent, json: { name: "conformance-agent", description: "From a server", type: "project", body: "A note." }, expect: 200 });
    await call("POST", "/memory/agent/tools/memory_save", { headers: agent, json: { name: "conformance-agent" }, expect: 400 });
    await call("POST", "/memory/agent/tools/memory_view", { headers: agent, json: { name: "conformance-kept" }, expect: 200 });

    await call("DELETE", "/memory/notes/conformance-style", { headers: alice, expect: 200 });
    await call("DELETE", "/memory/notes/conformance-style", { headers: alice, expect: 404 });
  });

  step("memory: shared notes and proposals", async () => {
    const input = { description: "How the team names runs", type: "project", body: "Date first." };
    const shared = await call<{ note: Schema["SharedNote"] }>("POST", "/memory/shared", { headers: alice, json: { scope: "workspace", name: "conformance-shared", ...input }, expect: 200 });
    const id = shared.data.note.id;
    await call("POST", "/memory/shared", { headers: alice, json: { scope: "workspace", name: "Not A Name", ...input }, expect: 400 });
    await call("GET", `/memory/shared/${id}`, { headers: alice, expect: 200 });
    await call("GET", `/memory/shared/${crypto.randomUUID()}`, { headers: alice, expect: 404 });
    await call("PUT", `/memory/shared/${id}`, { headers: alice, json: { ...input, body: "Date first, then the tool.", version: 1 }, expect: 200 });
    await call("PUT", `/memory/shared/${id}`, { headers: alice, json: { ...input, version: 1 }, expect: 409 });
    await call("PUT", `/memory/shared/${id}/mode`, { headers: alice, json: { mode: "manual" }, expect: 200 });
    await call("PUT", `/memory/shared/${id}/mode`, { headers: alice, json: { mode: "off", everyone: true }, expect: 200 });
    await call("PUT", `/memory/shared/${id}/mode`, { headers: alice, json: { mode: "loud" }, expect: 400 });

    // Bob views the tech node: what he shares there is a proposal for its editors.
    const propose = async (name: string) =>
      (await call<{ proposal: Schema["SharedProposal"] }>("POST", "/memory/shared", { headers: bob, json: { scope: "node", nodeId: tech.id, name, ...input }, expect: 200 })).data.proposal.id;
    await call("POST", `/memory/shared/proposals/${await propose("conformance-accepted")}/accept`, { headers: alice, expect: 200 });
    await call("POST", `/memory/shared/proposals/${await propose("conformance-rejected")}/reject`, { headers: alice, expect: 200 });
    await call("POST", `/memory/shared/proposals/${await propose("conformance-withdrawn")}/withdraw`, { headers: bob, expect: 200 });
    await call("POST", `/memory/shared/proposals/${crypto.randomUUID()}/accept`, { headers: alice, expect: 400 });
  });

  step("memory: packs", async () => {
    const pack = `conformance-pack-${stamp}`;
    await call("POST", "/memory/packs", { headers: alice, json: { scope: "workspace", name: pack, description: "The suite's notes" }, expect: 200 });
    await call("POST", "/memory/packs", { headers: alice, json: { scope: "workspace", description: "No name" }, expect: 400 });
    await call("GET", "/memory/packs", { headers: alice, expect: 200 });
    await call("GET", `/memory/packs?q=${pack}`, { headers: alice, expect: 200 });
    await call("GET", `/memory/packs/${pack}`, { headers: alice, expect: 200 });
    await call("GET", `/memory/packs/${pack}?version=one`, { headers: alice, expect: 400 });
    await call("GET", "/memory/packs/no-such-pack", { headers: alice, expect: 404 });
    await call("POST", `/memory/packs/${pack}/verify`, { headers: alice, json: { version: 1 }, expect: 200 });
    await call("POST", `/memory/packs/${pack}/verify`, { headers: alice, json: {}, expect: 400 });
    await call("POST", `/memory/packs/${pack}/yank`, { headers: alice, json: { version: 1, reason: "Checking" }, expect: 200 });
    await call("POST", `/memory/packs/${pack}/yank`, { headers: alice, json: { version: 1, yanked: false }, expect: 200 });
    const target = { scope: "node", nodeId: mod.id };
    const install = async () =>
      (await call<{ install: Schema["PackInstall"] }>("POST", `/memory/packs/${pack}/install`, { headers: alice, json: target, expect: 200 })).data.install.id;
    await call("DELETE", `/memory/installs/${await install()}`, { headers: alice, expect: 200 });
    await call("POST", `/memory/installs/${await install()}/fork`, { headers: alice, expect: 200 });
    await call("POST", `/memory/packs/${pack}/install`, { headers: bob, json: target, expect: 400 });
    const shared = await call<Schema["MemoryOverview"]>("GET", "/memory", { headers: alice, expect: 200 });
    const own = shared.data.shared.find((n) => n.name === "conformance-shared" && n.place.scope === "workspace")!;
    await call("DELETE", `/memory/shared/${own.id}`, { headers: alice, expect: 200 });
  });

  step("chats", async () => {
    const chatId = `conformance-chat-${stamp}`;
    await call("POST", `/chats/${chatId}/runs`, { headers: alice, json: { agentId: "default", runId: "r1", events: [{ type: "RUN_STARTED" }], messages: [{ id: "m1", role: "user", content: "hi" }], name: "Hi" }, expect: 201 });
    await call("POST", `/chats/${chatId}/runs`, { headers: alice, json: { agentId: "default", runId: "r2", parentRunId: "r1", events: [], messages: [] }, expect: 201 });
    await call("POST", `/chats/${chatId}/runs`, { headers: bob, json: { agentId: "default", runId: "r3", events: [], messages: [] }, expect: 403 });
    await call("POST", `/chats/${chatId}/runs`, { headers: alice, json: { agentId: "default" }, expect: 400 });
    await call("GET", "/chats", { headers: alice, expect: 200 });
    await call("GET", "/chats?limit=1&archived", { headers: alice, expect: 200 });
    await call("GET", `/chats/${chatId}`, { headers: alice, expect: 200 });
    await call("GET", `/chats/${chatId}`, { headers: bob, expect: 404 });
    await call("GET", `/chats/${chatId}/runs`, { headers: alice, expect: 200 });
    await call("PATCH", `/chats/${chatId}`, { headers: alice, json: { name: "Renamed", archived: true }, expect: 200 });
    await call("DELETE", `/chats/${chatId}`, { headers: alice, expect: 200 });
  });

  step("groups, members and the audit log", async () => {
    const group = (await call<Schema["Group"]>("POST", "/access/groups", { headers: alice, json: { parentId: null, name: `Team ${stamp}` }, expect: 201 })).data;
    await call("POST", "/access/groups", { headers: bob, json: { parentId: null, name: "Nope" }, expect: 403 });
    await call("GET", "/access/groups", { headers: alice, expect: 200 });
    await call("PATCH", `/access/groups/${group.id}`, { headers: alice, json: { name: "Team renamed" }, expect: 200 });
    await call("PUT", `/access/groups/${group.id}/members/${bobId}`, { headers: alice, expect: 200 });
    await call("DELETE", `/access/groups/${group.id}/members/${bobId}`, { headers: alice, expect: 200 });
    await call("GET", "/access/audit?limit=20&kind=grant", { headers: alice, expect: 200 });
    await call("DELETE", `/access/grants/${grant.id}`, { headers: alice, expect: 200 });
    await call("DELETE", `/access/groups/${group.id}`, { headers: alice, expect: 200 });
    await call("DELETE", "/access/groups/00000000-0000-0000-0000-000000000000", { headers: alice, expect: 404 });
  });

  step("server: health, identity key and follow-up suggestions", async () => {
    await call("GET", "/health", { expect: 200 });
    const key = await call<{ key: string }>("GET", "/identity/public-key", { expect: 200 });
    assert.ok(key.data.key, "a public key");
    const input = { threadId: `conformance-${stamp}`, runId: "s1", messages: [], tools: [], context: [] };
    await call("POST", "/suggest", { json: input, expect: 401 });
    await call("POST", "/suggest", { headers: { ...alice, "Content-Type": "application/json" }, body: "{", expect: 400 });
    // No copilotkitSuggest tool in the request: RUN_STARTED, then RUN_ERROR, and no model call.
    const res = await call("POST", "/suggest", { headers: alice, json: input, expect: 200 });
    const events = sseData(res.text);
    for (const event of events) validates("AgUiEvent", event, "suggest event");
    assert.deepEqual(events.map((e) => (e as { type: string }).type), ["RUN_STARTED", "RUN_ERROR"]);
  });

  step("tools menu", async () => {
    await call("GET", "/tools", { expect: 401 });
    await call("GET", "/tools", { headers: storageToken("conformance|alice"), expect: 401 });
    await call("GET", "/tools", { headers: alice, expect: 200 });
    await call("POST", "/tools/no-such-server/search", { headers: alice, json: { arguments: {} }, expect: 404 });
  });

  const skill = `conformance-${stamp}`;
  const skillMd = (line: string) => `---\nname: ${skill}\ndescription: A skill for the conformance suite\n---\n\n${line}\n`;

  step("skills", async () => {
    await call("PUT", `/files/skills/${skill}/SKILL.md`, { headers: alice, body: skillMd("First version."), expect: 200 });
    await call("GET", "/skills", { expect: 401 });
    await call("GET", "/skills", { headers: storageToken("conformance|alice"), expect: 401 });
    const list = await call<Schema["SkillList"]>("GET", "/skills", { headers: alice, expect: 200 });
    assert.equal(list.data.skills.find((s) => s.name === skill)?.source, "workspace");
    const builtin = list.data.skills.find((s) => s.source === "builtin")!.name;
    await call("GET", `/skills?thread=conformance-${stamp}`, { headers: alice, expect: 200 });
    await call("PUT", `/skills/${skill}`, { headers: alice, json: { mode: "manual" }, expect: 200 });
    await call("PUT", `/skills/${skill}`, { headers: alice, json: { mode: "off", scope: "chat", thread: `conformance-${stamp}` }, expect: 200 });
    await call("PUT", `/skills/${skill}`, { headers: alice, json: { mode: null, scope: "workspace" }, expect: 200 });
    await call("PUT", `/skills/${skill}`, { headers: alice, json: { mode: "sometimes" }, expect: 400 });
    await call("PUT", `/skills/${builtin}`, { headers: bob, json: { mode: "off", scope: "workspace" }, expect: 403 });
    await call("PUT", "/skills/no-such-skill", { headers: alice, json: { mode: "off" }, expect: 404 });
    const zip = await call("GET", `/skills/${skill}/export`, { headers: alice, expect: 200 });
    assert.equal(zip.res.headers.get("content-type"), "application/zip");
    const bytes = new Uint8Array(await (await fetch(`${BASE}/skills/${skill}/export`, { headers: alice })).arrayBuffer());
    const asZip = { ...alice, "Content-Type": "application/zip" };
    await call("POST", "/skills/import", { headers: asZip, body: bytes, expect: 409 });
    await call("POST", "/skills/import?replace=1", { headers: asZip, body: bytes, expect: 201 });
    await call("POST", "/skills/import", { headers: asZip, body: new Uint8Array([1, 2, 3]), expect: 400 });

    // What an outside agent's run gets, with the run's storage token: modes as in that chat, files in base64.
    const thread = `conformance-run-${stamp}`;
    await call("GET", "/skills/run", { expect: 401 });
    await call("PUT", `/skills/${skill}`, { headers: alice, json: { mode: "manual", scope: "chat", thread }, expect: 200 });
    const run = await call<{ skills: Schema["RunSkill"][] }>(
      "GET", `/skills/run?thread=${thread}`, { headers: storageToken("conformance|alice"), expect: 200 },
    );
    const mine = run.data.skills.find((s) => s.name === skill)!;
    assert.equal(mine.mode, "manual");
    assert.equal(mine.source, "workspace");
    const md = mine.files.find((f) => f.path === "SKILL.md")!;
    assert.match(Buffer.from(md.content, "base64").toString("utf8"), /name: conformance-/);
    await call("PUT", `/skills/${skill}`, { headers: alice, json: { mode: "off", scope: "chat", thread }, expect: 200 });
    const off = await call<{ skills: Schema["RunSkill"][] }>("GET", `/skills/run?thread=${thread}`, { headers: alice, expect: 200 });
    assert.ok(!off.data.skills.some((s) => s.name === skill));
    const used = await call<{ source: string }>("POST", "/skills/used", {
      headers: storageToken("conformance|alice"),
      json: { thread, run: "r1", skill, trigger: "slash" },
      expect: 200,
    });
    assert.equal(used.data.source, "workspace");
    await call("POST", "/skills/used", { headers: alice, json: { thread, skill, trigger: "sometimes" }, expect: 400 });
    await call("POST", "/skills/used", { headers: alice, json: { thread, skill: "no-such-skill", trigger: "model" }, expect: 404 });
    // The token reads skills and notes uses, nothing else on those paths (PUT or DELETE
    // /skills/run is /skills/{name} for a skill named "run"; fetched directly, as the spec
    // matches these paths to the literal routes).
    for (const method of ["PUT", "DELETE"]) {
      for (const path of ["/skills/run", "/skills/used"]) {
        const res = await fetch(`${BASE}${path}`, {
          method,
          headers: { ...storageToken("conformance|alice"), "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "off" }),
        });
        assert.equal(res.status, 401, `${method} ${path} with a storage token`);
      }
    }
  });

  step("skill hub", async () => {
    await call("GET", "/hub", { headers: alice, expect: 200 });
    // Bob has no role at the workspace root, which every /hub route needs.
    await call("GET", "/hub", { headers: bob, expect: 403 });
    await call("POST", "/hub", { headers: alice, json: {}, expect: 400 });
    await call("POST", "/hub", { headers: bob, json: { skill }, expect: 403 });
    const v1 = await call<{ version: number }>("POST", "/hub", { headers: alice, json: { skill }, expect: 201 });
    await call("PUT", `/files/skills/${skill}/SKILL.md`, { headers: alice, body: skillMd("Second version."), expect: 200 });
    const v2 = await call<{ version: number }>("POST", "/hub", { headers: alice, json: { skill }, expect: 201 });
    assert.equal(v2.data.version, v1.data.version + 1);
    await call("GET", `/hub?q=${skill}`, { headers: alice, expect: 200 });
    await call("GET", `/hub/${skill}`, { headers: alice, expect: 200 });
    await call("GET", `/hub/${skill}?version=${v1.data.version}`, { headers: alice, expect: 200 });
    await call("GET", "/hub/no-such-skill", { headers: alice, expect: 404 });
    await call("GET", `/hub/${skill}/diff?from=${v1.data.version}&to=${v2.data.version}`, { headers: alice, expect: 200 });
    await call("GET", `/hub/${skill}/diff?from=${v1.data.version}`, { headers: alice, expect: 400 });

    // Reports: anyone who reads the workspace files one, hub admins (HUB_ADMINS) dismiss it.
    await call("POST", `/hub/${skill}/reports`, { headers: bob, json: { reason: "Just checking" }, expect: 403 });
    const report = await call<{ id: string }>("POST", `/hub/${skill}/reports`, { headers: alice, json: { reason: "Just checking", version: v2.data.version }, expect: 201 });
    await call("DELETE", `/hub/${skill}/reports?id=${report.data.id}`, { headers: bob, expect: 403 });
    await call("DELETE", `/hub/${skill}/reports?id=${report.data.id}`, { headers: alice, expect: 200 });
    await call("POST", `/hub/${skill}/verify`, { headers: bob, json: { version: v1.data.version }, expect: 403 });
    await call("POST", `/hub/${skill}/verify`, { headers: alice, json: { version: v1.data.version }, expect: 200 });
    await call("POST", `/hub/${skill}/yank`, { headers: alice, json: { version: v1.data.version, reason: "Old" }, expect: 200 });
    await call("POST", `/hub/${skill}/yank`, { headers: alice, json: {}, expect: 400 });

    // The workspace's own folder of that name is in the way of a fork; once it's gone, both work.
    await call("POST", `/hub/${skill}/fork`, { headers: alice, expect: 409 });
    await call("DELETE", `/skills/${skill}`, { headers: bob, expect: 403 });
    await call("DELETE", `/skills/${skill}`, { headers: alice, expect: 200 });
    await call("DELETE", `/skills/${skill}`, { headers: alice, expect: 404 });
    await call("PUT", `/hub/${skill}/install`, { headers: bob, json: {}, expect: 403 });
    await call("PUT", `/hub/${skill}/install`, { headers: alice, json: { version: v2.data.version }, expect: 200 });
    await call("DELETE", `/hub/${skill}/install`, { headers: alice, expect: 200 });
    await call("DELETE", `/hub/${skill}/install`, { headers: alice, expect: 404 });
    await call("POST", `/hub/${skill}/fork`, { headers: alice, expect: 201 });
    await call("DELETE", `/skills/${skill}`, { headers: alice, expect: 200 });
  });

  step("deletes", async () => {
    await call("DELETE", `/experiments/${exp.id}`, { headers: alice, expect: 200 });
    await call("DELETE", `/nodes/${tech.id}`, { headers: alice, expect: 200 });
  });

  test("every operation in the spec was called", () => {
    const operations = Object.values(spec.paths).flatMap((item) =>
      Object.entries(item).filter(([method]) => METHODS.includes(method)).map(([, op]) => op.operationId),
    );
    const untouched = operations.filter((id) => ![...covered].some((c) => c.startsWith(`${id} `)));
    assert.deepEqual(untouched, [], "add a call for each new operation in openapi/storage.yaml");
  });
});
