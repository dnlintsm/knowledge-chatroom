/**
 * Storage settings from the environment. Storage is optional: without
 * DATABASE_URL the agent runs as before and the /files API answers 404.
 *
 * The S3 settings work with any S3-compatible store: the bundled SeaweedFS
 * (docker-compose.yml), Garage, AWS S3, Cloudflare R2 or Backblaze B2.
 */

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
  };
}

function authSecretFromEnv(env: NodeJS.ProcessEnv) {
  const secret = env.AUTH_SECRET || undefined;
  if (secret && secret.length < 32) {
    throw new Error("AUTH_SECRET must be at least 32 characters (e.g. openssl rand -hex 32)");
  }
  return secret;
}
