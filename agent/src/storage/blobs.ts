import { createHash } from "node:crypto";

import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import type { StorageConfig } from "./config";

/**
 * Content-addressed byte storage: a blob's key is the sha256 of its bytes, so
 * blobs never change once written and identical content is stored once.
 */
export interface BlobStore {
  put(sha256: string, bytes: Uint8Array, mime: string): Promise<void>;
  get(sha256: string): Promise<Uint8Array>;
  /**
   * A short-lived link browsers can download the blob from, or null when the
   * store isn't reachable from browsers (bytes then go through the app).
   */
  downloadUrl(sha256: string, opts: { mime: string; filename: string }): Promise<string | null>;
}

/** How long a download link works. Access is checked when the link is made. */
export const DOWNLOAD_LINK_SECONDS = 300;

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e?.name === "NotFound" ||
    e?.name === "NoSuchKey" ||
    e?.name === "NoSuchBucket" ||
    e?.$metadata?.httpStatusCode === 404
  );
}

export class S3BlobStore implements BlobStore {
  private readonly client: S3Client;
  /** Signs links for the address browsers use (S3_PUBLIC_URL). */
  private readonly publicClient: S3Client | null;
  private readonly bucket: string;

  constructor(config: StorageConfig["s3"]) {
    this.bucket = config.bucket;
    const client = (endpoint: string | undefined) =>
      new S3Client({
        endpoint,
        region: config.region,
        forcePathStyle: config.forcePathStyle,
        credentials:
          config.accessKeyId && config.secretAccessKey
            ? {
                accessKeyId: config.accessKeyId,
                secretAccessKey: config.secretAccessKey,
              }
            : undefined,
      });
    this.client = client(config.endpoint);
    this.publicClient = config.publicUrl ? client(config.publicUrl) : null;
  }

  private key(sha256: string) {
    return `blobs/${sha256.slice(0, 2)}/${sha256}`;
  }

  /** Creates the bucket when missing, so a fresh self-hosted store just works. */
  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (err) {
      if (!isNotFound(err)) throw err;
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
  }

  async put(sha256: string, bytes: Uint8Array, mime: string): Promise<void> {
    const Key = this.key(sha256);
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key }));
      return; // Same hash, same bytes: already stored.
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key,
        Body: bytes,
        ContentType: mime,
        ContentLength: bytes.byteLength,
      }),
    );
  }

  async get(sha256: string): Promise<Uint8Array> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: this.key(sha256) }),
    );
    if (!res.Body) throw new Error(`Blob ${sha256} has no body`);
    return res.Body.transformToByteArray();
  }

  async downloadUrl(sha256: string, opts: { mime: string; filename: string }): Promise<string | null> {
    if (!this.publicClient) return null;
    return getSignedUrl(
      this.publicClient,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.key(sha256),
        ResponseContentType: opts.mime,
        ResponseContentDisposition: `inline; filename*=UTF-8''${encodeURIComponent(opts.filename)}`,
      }),
      { expiresIn: DOWNLOAD_LINK_SECONDS },
    );
  }
}
