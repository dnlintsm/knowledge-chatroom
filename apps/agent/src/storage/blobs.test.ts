import assert from "node:assert/strict";
import { test } from "node:test";

import { S3BlobStore } from "./blobs";

/**
 * ensureBucket against a fake S3 client: both servers create the bucket at
 * startup, and the one that loses the race must still start (issue #243).
 */

type Reply = Error | undefined;

function storeWith(replies: Record<string, Reply[]>) {
  const store = new S3BlobStore({ endpoint: "http://s3.test", region: "us-east-1", bucket: "kb", forcePathStyle: true });
  const calls: string[] = [];
  (store as unknown as { client: unknown }).client = {
    send: async (command: { constructor: { name: string } }) => {
      const name = command.constructor.name;
      calls.push(name);
      const err = replies[name]?.shift();
      if (err) throw err;
      return {};
    },
  };
  return { store, calls };
}

const s3Error = (name: string, status: number) =>
  Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });

test("creates the bucket when it is missing", async () => {
  const { store, calls } = storeWith({ HeadBucketCommand: [s3Error("NotFound", 404)] });
  await store.ensureBucket();
  assert.deepEqual(calls, ["HeadBucketCommand", "CreateBucketCommand"]);
});

for (const name of ["BucketAlreadyOwnedByYou", "BucketAlreadyExists"]) {
  test(`starts when another server created the bucket first (${name})`, async () => {
    const { store, calls } = storeWith({
      HeadBucketCommand: [s3Error("NotFound", 404)],
      CreateBucketCommand: [s3Error(name, 409)],
    });
    await store.ensureBucket();
    assert.deepEqual(calls, ["HeadBucketCommand", "CreateBucketCommand", "HeadBucketCommand"]);
  });
}

test("fails when the existing bucket belongs to someone else", async () => {
  const { store } = storeWith({
    HeadBucketCommand: [s3Error("NotFound", 404), s3Error("Forbidden", 403)],
    CreateBucketCommand: [s3Error("BucketAlreadyExists", 409)],
  });
  await assert.rejects(store.ensureBucket(), { name: "Forbidden" });
});

test("fails on any other CreateBucket error", async () => {
  const { store } = storeWith({
    HeadBucketCommand: [s3Error("NotFound", 404)],
    CreateBucketCommand: [s3Error("AccessDenied", 403)],
  });
  await assert.rejects(store.ensureBucket(), { name: "AccessDenied" });
});
