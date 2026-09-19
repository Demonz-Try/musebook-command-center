import { createHash } from "node:crypto";

/**
 * Immutable copies of the bytes we fetched when a submission was verified.
 *
 * This is the one thing in the system that is a file rather than a record, so
 * it is the one thing that lives in Netlify Blobs; bounties, claims, receipts,
 * votes, watermarks, jobs and keys are all rows in Netlify Database. A hash on
 * its own proves two fetches differed but cannot show what the worker actually
 * submitted, and that is exactly the evidence a disputed bounty turns on.
 *
 * Keys are content-addressed, so storing the same bytes twice is a no-op and a
 * snapshot can never be rewritten under a hash that no longer matches it.
 */
const STORE = "submission-snapshots";
const MAX_BYTES = 5 * 1024 * 1024;

export interface Snapshot {
  key: string;
  hash: string;
  byteLength: number;
  contentType: string | null;
}

export function snapshotKey(hash: string): string {
  return `sha256/${hash}`;
}

function toArrayBuffer(body: Buffer): ArrayBuffer {
  return body.buffer.slice(
    body.byteOffset,
    body.byteOffset + body.byteLength,
  ) as ArrayBuffer;
}

interface Backend {
  set(key: string, body: Buffer, contentType: string | null): Promise<void>;
  get(key: string): Promise<Buffer | null>;
}

let backend: Backend | null = null;

async function blobs(): Promise<Backend | null> {
  try {
    const { getStore } = await import("@netlify/blobs");
    const store = getStore({ name: STORE, consistency: "strong" });
    return {
      async set(key, body, contentType) {
        await store.set(key, toArrayBuffer(body), {
          metadata: { contentType: contentType ?? "application/octet-stream" },
        });
      },
      async get(key) {
        const found = await store.get(key, { type: "arrayBuffer" });
        return found ? Buffer.from(found) : null;
      },
    };
  } catch {
    // Not running on Netlify compute. Blobs throws rather than degrading, and
    // a local run losing its snapshots is better than a local run refusing to
    // accept submissions at all.
    return null;
  }
}

function memory(): Backend {
  const held = new Map<string, Buffer>();
  return {
    async set(key, body) {
      held.set(key, body);
    },
    async get(key) {
      return held.get(key) ?? null;
    },
  };
}

async function open(): Promise<Backend> {
  backend ??= (await blobs()) ?? memory();
  return backend;
}

/**
 * Hashes the bytes and keeps them. Returns the hash even when the store is
 * unavailable, because the hash is what the receipt commits to — losing the
 * copy weakens the evidence but must not fail the submission.
 */
export async function keepSnapshot(
  body: Buffer,
  contentType: string | null,
): Promise<Snapshot> {
  if (body.byteLength > MAX_BYTES) {
    throw new Error(`snapshot of ${body.byteLength} bytes exceeds ${MAX_BYTES}`);
  }
  const hash = createHash("sha256").update(body).digest("hex");
  const key = snapshotKey(hash);
  try {
    const store = await open();
    await store.set(key, body, contentType);
  } catch {
    // Deliberately swallowed: see above.
  }
  return { key, hash, byteLength: body.byteLength, contentType };
}

export async function readSnapshot(key: string): Promise<Buffer | null> {
  const store = await open();
  return store.get(key);
}

export function resetSnapshotsForTests(): void {
  backend = memory();
}
