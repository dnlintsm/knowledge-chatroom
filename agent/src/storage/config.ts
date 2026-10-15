/**
 * Storage settings from the environment. Storage is optional: without
 * DATABASE_URL the agent runs as before and the /files API answers 404.
 *
 * The S3 settings work with any S3-compatible store: the bundled SeaweedFS
 * (docker-compose.yml), Garage, AWS S3, Cloudflare R2 or Backblaze B2.
 */

import { authSettings } from "../../../shared/auth-mode";

export interface StorageConfig {
  databaseUrl: string;
  s3: {
    endpoint?: string;
    region: string;
    bucket: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    /** Self-hosted stores usually need path-style URLs (endpoint/bucket/key). */
    forcePathStyle: boolean;
    /**
     * The store's address as browsers reach it. When set, downloads of binary
     * files go straight to the store through short-lived signed links instead
     * of streaming through the app.
     */
    publicUrl?: string;
  };
  maxUploadBytes: number;
  /**
   * Shared with the Next.js app, which signs who is logged in (identity.ts).
   * Unset: no login, everyone is the local user who owns the workspace.
   */
  authSecret?: string;
  /**
   * The embedding model for search by meaning (semantic.ts), run inside the
   * agent; null when turned off (EMBEDDING_MODEL=off). Needs Postgres with
   * pgvector; without it search stays word-based.
   */
  embeddingModel: string | null;
  /** Where the model is downloaded to on first use. */
  embeddingCacheDir?: string;
  /**
   * An OpenAI-compatible embeddings endpoint (LiteLLM, OpenRouter, OpenAI,
   * vLLM, Ollama...) to call instead of running the model inside the agent;
   * set by EMBEDDING_BASE_URL. embeddingModel is then the name it knows.
   */
  embeddingApi?: EmbeddingApiConfig;
}

export interface EmbeddingApiConfig {
  /** Up to and including the version, e.g. https://openrouter.ai/api/v1. */
  baseUrl: string;
  apiKey?: string;
  /** Asked of models that can shorten their vectors (text-embedding-3-*). */
  dimensions?: number;
}

export const DEFAULT_EMBEDDING_MODEL = "Xenova/multilingual-e5-small";

export function storageConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): StorageConfig | null {
  if (!env.DATABASE_URL) return null;
  return {
    databaseUrl: env.DATABASE_URL,
    s3: {
      endpoint: env.S3_ENDPOINT || undefined,
      region: env.S3_REGION || "us-east-1",
      bucket: env.S3_BUCKET || "knowledge",
      accessKeyId: env.S3_ACCESS_KEY_ID || undefined,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY || undefined,
      forcePathStyle: (env.S3_FORCE_PATH_STYLE ?? "true") !== "false",
      publicUrl: env.S3_PUBLIC_URL || undefined,
    },
    maxUploadBytes: Number.parseInt(
      env.MAX_UPLOAD_BYTES || String(50 * 1024 * 1024),
      10,
    ),
    authSecret: authSecretFromEnv(env),
    embeddingModel:
      env.EMBEDDING_MODEL === "off" ? null : env.EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL,
    embeddingCacheDir: env.EMBEDDING_CACHE_DIR || undefined,
    embeddingApi: embeddingApiFromEnv(env),
  };
}

function embeddingApiFromEnv(env: NodeJS.ProcessEnv): EmbeddingApiConfig | undefined {
  const baseUrl = env.EMBEDDING_BASE_URL || undefined;
  if (!baseUrl || env.EMBEDDING_MODEL === "off") return undefined;
  if (!env.EMBEDDING_MODEL) {
    throw new Error(
      "EMBEDDING_BASE_URL needs EMBEDDING_MODEL, the model name the endpoint knows " +
        "(e.g. openai/text-embedding-3-small on OpenRouter)",
    );
  }
  const raw = env.EMBEDDING_DIMENSIONS?.trim();
  if (raw && !/^[1-9]\d*$/.test(raw)) {
    throw new Error("EMBEDDING_DIMENSIONS must be a positive whole number");
  }
  const dims = raw ? Number(raw) : undefined;
  return { baseUrl, apiKey: env.EMBEDDING_API_KEY || undefined, dimensions: dims };
}

// AUTH_MODE / AUTH_SECRET, read as the Next.js app reads them; throws on
// settings that would silently turn login off in production.
function authSecretFromEnv(env: NodeJS.ProcessEnv) {
  return authSettings(env).secret;
}
