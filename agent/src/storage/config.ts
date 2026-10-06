/**
 * Storage settings from the environment. Storage is optional: without
 * DATABASE_URL the agent runs as before and the /files API answers 503.
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
  };
  maxUploadBytes: number;
}

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
    },
    maxUploadBytes: Number.parseInt(
      env.MAX_UPLOAD_BYTES || String(50 * 1024 * 1024),
      10,
    ),
  };
}
