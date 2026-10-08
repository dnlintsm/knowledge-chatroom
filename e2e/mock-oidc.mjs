/**
 * A tiny OpenID Connect provider for login tests (login.spec.ts): discovery,
 * an authorize page that lets you pick a test user, a token endpoint with
 * PKCE, and RS256 ID tokens. Never use it for anything real.
 *
 *   OIDC_PORT=9400 node e2e/mock-oidc.mjs
 *   OIDC_ISSUER=http://localhost:9400  OIDC_CLIENT_ID=knowledge-chatroom
 */

import http from "node:http";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";

const PORT = Number(process.env.OIDC_PORT || 9400);
const ISSUER = `http://localhost:${PORT}`;
const USERS = {
  alice: { name: "Alice Admin", email: "alice@example.com" },
  bob: { name: "Bob Builder", email: "bob@example.com" },
};

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test", alg: "RS256", use: "sig" };
const codes = new Map();

const b64 = (data) => Buffer.from(data).toString("base64url");
function idToken(claims) {
  const head = b64(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "test" }));
  const body = b64(JSON.stringify(claims));
  return `${head}.${body}.${b64(sign("sha256", Buffer.from(`${head}.${body}`), privateKey))}`;
}

const json = (res, status, data) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
};
const escape = (s) => String(s).replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);

async function form(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", ISSUER);

  if (url.pathname === "/health") return json(res, 200, { ok: true });

  if (url.pathname === "/.well-known/openid-configuration") {
    return json(res, 200, {
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: `${ISSUER}/jwks`,
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic", "none"],
      scopes_supported: ["openid", "email", "profile"],
    });
  }

  if (url.pathname === "/jwks") return json(res, 200, { keys: [jwk] });

  if (url.pathname === "/authorize" && req.method === "GET") {
    const keep = ["client_id", "redirect_uri", "state", "nonce", "code_challenge"]
      .map((k) => `<input type="hidden" name="${k}" value="${escape(url.searchParams.get(k) ?? "")}">`)
      .join("");
    const buttons = Object.entries(USERS)
      .map(([id, u]) => `<button name="user" value="${id}">Sign in as ${escape(u.name)}</button>`)
      .join(" ");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(
      `<!doctype html><title>Test login</title><h1>Test login provider</h1><form method="post" action="/authorize">${keep}${buttons}</form>`,
    );
  }

  if (url.pathname === "/authorize" && req.method === "POST") {
    const params = await form(req);
    const user = params.get("user");
    if (!USERS[user]) return json(res, 400, { error: "unknown user" });
    const code = randomBytes(16).toString("hex");
    codes.set(code, {
      user,
      clientId: params.get("client_id"),
      redirectUri: params.get("redirect_uri"),
      nonce: params.get("nonce"),
      challenge: params.get("code_challenge"),
    });
    const back = new URL(params.get("redirect_uri"));
    back.searchParams.set("code", code);
    if (params.get("state")) back.searchParams.set("state", params.get("state"));
    res.writeHead(302, { Location: back.toString() });
    return res.end();
  }

  if (url.pathname === "/token" && req.method === "POST") {
    const params = await form(req);
    const grant = codes.get(params.get("code"));
    codes.delete(params.get("code"));
    const basic = req.headers.authorization?.startsWith("Basic ")
      ? Buffer.from(req.headers.authorization.slice(6), "base64").toString().split(":")[0]
      : null;
    const clientId = params.get("client_id") ?? (basic && decodeURIComponent(basic));
    const verifier = params.get("code_verifier") ?? "";
    if (
      !grant ||
      grant.clientId !== clientId ||
      grant.redirectUri !== params.get("redirect_uri") ||
      b64(createHash("sha256").update(verifier).digest()) !== grant.challenge
    ) {
      return json(res, 400, { error: "invalid_grant" });
    }
    const now = Math.floor(Date.now() / 1000);
    return json(res, 200, {
      access_token: randomBytes(16).toString("hex"),
      token_type: "Bearer",
      expires_in: 300,
      id_token: idToken({
        iss: ISSUER,
        sub: grant.user,
        aud: clientId,
        iat: now,
        exp: now + 300,
        nonce: grant.nonce,
        ...USERS[grant.user],
      }),
    });
  }

  json(res, 404, { error: "not found" });
});

server.listen(PORT, () => console.log(`[mock-oidc] listening on ${ISSUER}`));
