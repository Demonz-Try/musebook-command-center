import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { authenticate, issueApiKey } from "@/platform/auth";
import { deployContext } from "@/platform/deploy";
import { keepSnapshot, readSnapshot } from "@/platform/snapshots";
import { fetchAndHashAnswer, submitAnswer } from "@/modules/answer/service";
import { answers } from "@/modules/answer/schema";
import { eq } from "drizzle-orm";
import { resetDatabase, WORKER } from "./helpers";

beforeEach(resetDatabase);

function inContext<T>(context: string, run: () => Promise<T>): Promise<T> {
  const before = process.env.CONTEXT;
  process.env.CONTEXT = context;
  return run().finally(() => {
    if (before === undefined) delete process.env.CONTEXT;
    else process.env.CONTEXT = before;
  });
}

function bearer(key: string): Request {
  return new Request("http://command-center.test/api/bounties", {
    headers: { authorization: `Bearer ${key}` },
  });
}

describe("API keys are bound to the deploy that issued them", () => {
  it("reads the deploy context from Netlify, and calls anything else dev", () => {
    expect(deployContext()).toBe("dev");
  });

  it("authenticates a key in the context it was issued in", async () => {
    const issued = await inContext("production", () => issueApiKey(WORKER));
    const caller = await inContext("production", () => authenticate(bearer(issued.key)));
    expect(caller.actor.id).toBe("@worker");
  });

  it("refuses a production key against a preview forked from production", async () => {
    const issued = await inContext("production", () => issueApiKey(WORKER));

    // The row is present in the preview — that is the whole hazard. What must
    // not happen is that it opens the door.
    await expect(
      inContext("deploy-preview", () => authenticate(bearer(issued.key))),
    ).rejects.toMatchObject({ code: "unauthorized" });

    const message = await inContext("deploy-preview", () =>
      authenticate(bearer(issued.key)).catch((e: Error) => e.message),
    );
    expect(message).toContain("issued for the production deploy");
  });

  it("lets a preview issue its own keys", async () => {
    const issued = await inContext("deploy-preview", () => issueApiKey(WORKER));
    const caller = await inContext("deploy-preview", () =>
      authenticate(bearer(issued.key)),
    );
    expect(caller.actor.id).toBe("@worker");
  });
});

describe("submission snapshots", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("addresses a snapshot by the hash of its bytes", async () => {
    const kept = await keepSnapshot(Buffer.from("the work"), "text/plain");
    const again = await keepSnapshot(Buffer.from("the work"), "text/plain");

    expect(kept.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(again.key).toBe(kept.key);
    expect((await readSnapshot(kept.key))?.toString()).toBe("the work");
  });

  it("hashes bytes rather than a decoded string, so two binaries differ", async () => {
    const a = await keepSnapshot(Buffer.from([0xff, 0xfe, 0x00]), null);
    const b = await keepSnapshot(Buffer.from([0xff, 0xfd, 0x00]), null);
    expect(a.hash).not.toBe(b.hash);
  });

  it("keeps the fetched bytes with the answer that was verified against them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("# my submission", {
            status: 200,
            headers: { "content-type": "text/markdown" },
          }),
      ),
    );

    const { answer } = await submitAnswer({
      actor: WORKER,
      subject: "post_991",
      url: "https://example.test/work.md",
    });
    const verified = await fetchAndHashAnswer(answer.id);

    expect(verified.status).toBe("verified");
    expect(verified.snapshotKey).toBe(`sha256/${verified.contentHash}`);
    expect((await readSnapshot(verified.snapshotKey!))?.toString()).toBe(
      "# my submission",
    );
  });

  it("records no snapshot for a URL it could not read", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));

    const { answer } = await submitAnswer({
      actor: WORKER,
      subject: "post_992",
      url: "https://example.test/gone",
    });
    await fetchAndHashAnswer(answer.id);

    const db = await getDb();
    const [row] = await db.select().from(answers).where(eq(answers.id, answer.id));
    expect(row.status).toBe("unreachable");
    expect(row.snapshotKey).toBeNull();
  });
});
