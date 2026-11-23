import path from "node:path";
import dotenv from "dotenv";
import type { NextConfig } from "next";

// The repository root: one .env for the UI and the agent, and the folder the
// standalone build traces files from (pnpm keeps packages in its node_modules).
const REPO_ROOT = path.resolve(__dirname, "../..");
// Next reads .env files from this app's folder only; the repository's .env (shared
// with the agent) sits at the root. Values already in the environment win, as with
// Next's own loading. (@next/env's loadEnvConfig won't do: it keeps the first
// folder it loaded.)
dotenv.config({ path: path.join(REPO_ROOT, ".env"), quiet: true });

// Sent with every page (issue #291). The API routes are left out: stored files
// served through them carry their own, stricter policy (`sandbox`) from the API
// server, and a second Content-Security-Policy here must not get in its way.
// No script-src or img-src: Next's inline scripts and the object store's signed
// links would need per-deployment values; images in rendered markdown are
// limited in the renderer instead (localImagesOnly).
const SECURITY_HEADERS = [
  // No other site frames the app (clickjacking); no plugins; no <base> rewrites.
  { key: "Content-Security-Policy", value: "frame-ancestors 'self'; object-src 'none'; base-uri 'self'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];

const nextConfig: NextConfig = {
  headers: async () => [{ source: "/((?!api/).*)", headers: SECURITY_HEADERS }],
  output: "standalone",
  outputFileTracingRoot: REPO_ROOT,
  turbopack: { root: REPO_ROOT },
  serverExternalPackages: ["@copilotkit/runtime"],
  // Workspace package shipped as TypeScript source (packages/contracts).
  transpilePackages: ["@knowledge-chatroom/contracts"],
  env: {
    // NEXT_PUBLIC_* resolves at build time while the Runtime reads the project key
    // per request. Provide CPK_INTELLIGENCE_API_KEY during the host build so the
    // browser gate matches the managed Runtime configuration.
    NEXT_PUBLIC_COPILOTKIT_THREADS_ENABLED: process.env.CPK_INTELLIGENCE_API_KEY
      ? "true"
      : "false",
  },
};

export default nextConfig;
