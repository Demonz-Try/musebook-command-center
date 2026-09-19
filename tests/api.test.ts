import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as answerPost } from "@/app/api/answer/route";
import { GET as bountiesGet, POST as bountiesPost } from "@/app/api/bounties/route";
import { POST as agreePost } from "@/app/api/bounties/[id]/agree/route";
import { POST as disputePost } from "@/app/api/bounties/[id]/dispute/route";
import { POST as fundPost } from "@/app/api/bounties/[id]/fund/route";
import { POST as releasePost } from "@/app/api/bounties/[id]/release/route";
import { POST as votePost } from "@/app/api/bounties/[id]/votes/route";
import { POST as submissionsPost } from "@/app/api/bounties/[id]/submissions/route";
import { GET as commandsGet, POST as commandsPost } from "@/app/api/commands/route";
import { POST as deadlineCheckPost } from "@/app/api/deadlines/check/route";
import { GET as jobGet } from "@/app/api/jobs/[id]/route";
import { issueApiKey } from "@/platform/auth";
import { runJobNow } from "@/platform/async-jobs";
import {
  COUNCIL,
  HOUR,
  OWNER,
  resetDatabase,
  WORKER,
  WORKER_WALLET,
} from "./helpers";

const BASE = "http://command-center.test";

let ownerKey: string;
let workerKey: string;
let councilKeys: string[];

beforeEach(async () => {
  await resetDatabase();
  // Enrolled keys, because everything here that moves money needs key_bound: a
  // plain API key only reaches platform_asserted, and the gap between the two
  // is the authorization story rather than a formality.
  const bound = { assurance: "key_bound" as const, boundVia: "test" };
  ownerKey = (await issueApiKey(OWNER, bound)).key;
  workerKey = (await issueApiKey(WORKER, bound)).key;
  councilKeys = [];
  for (const member of COUNCIL) {
    councilKeys.push((await issueApiKey(member, bound)).key);
  }
});

function post(path: string, key: string, body: unknown, idempotencyKey?: string) {
  const headers: Record<string, string> = {
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
  };
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  return new Request(`${BASE}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? {}),
  });
}

function get(path: string, key?: string) {
  return new Request(`${BASE}${path}`, {
    headers: key ? { authorization: `Bearer ${key}` } : {},
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function createBounty(overrides: Record<string, unknown> = {}, key = ownerKey) {
  const response = await bountiesPost(
    post(
      "/api/bounties",
      key,
      {
        title: "Write the payout runbook",
        brief: "Document how escrow settles.",
        amount: "$250.00",
        deadlineAt: new Date(Date.now() + 48 * HOUR).toISOString(),
        council: COUNCIL,
        councilQuorum: 2,
        ...overrides,
      },
      `post_${Math.random().toString(36).slice(2)}`,
    ),
  );
  return { response, body: await response.json() };
}

/**
 * A bounty with money actually in escrow.
 *
 * Creation and funding are separate steps and ownership mints at funding, so a
 * test that only creates has no owner and every payout path correctly refuses
 * it. Most of these tests are about what happens to money, so they start here.
 */
async function fundedBounty(overrides: Record<string, unknown> = {}) {
  const { body } = await createBounty(overrides);
  const id = body.bounty.id as string;
  await fundPost(
    post(`/api/bounties/${id}/fund`, ownerKey, {}, `fund_${id}`),
    params(id),
  );
  return { id, body };
}

describe("authentication", () => {
  it("rejects a request with no API key", async () => {
    const response = await bountiesGet(get("/api/bounties"));
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("unauthorized");
  });

  it("rejects an unknown key", async () => {
    const response = await bountiesGet(get("/api/bounties", "mb_live_nope"));
    expect(response.status).toBe(401);
  });

  it("never accepts a key from the query string", async () => {
    const response = await bountiesGet(get(`/api/bounties?api_key=${ownerKey}`));
    expect(response.status).toBe(401);
  });

  it("attributes the bounty to the muse who owns the key", async () => {
    const { body } = await createBounty();
    expect(body.bounty.creator).toBe(OWNER);
  });
});

describe("idempotency", () => {
  it("requires a key on every POST", async () => {
    const response = await bountiesPost(
      post("/api/bounties", ownerKey, { title: "x" }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("validation");
  });

  it("replays the first response instead of creating a second bounty", async () => {
    // A retry is byte-identical, the way a real client would resend it.
    const body = {
      title: "Runbook",
      brief: "Write it",
      amount: "$100.00",
      deadlineAt: new Date(Date.now() + 48 * HOUR).toISOString(),
    };
    const request = () => post("/api/bounties", ownerKey, body, "post_4711");

    const first = await bountiesPost(request());
    const second = await bountiesPost(request());
    const firstBody = await first.json();
    const secondBody = await second.json();

    expect(firstBody.bounty.id).toBe(secondBody.bounty.id);
    expect(firstBody.idempotency.replayed).toBe(false);
    expect(secondBody.idempotency.replayed).toBe(true);

    const list = await (await bountiesGet(get("/api/bounties", ownerKey))).json();
    expect(list.data).toHaveLength(1);
  });

  it("never lets a double-submitted payout move funds twice", async () => {
    const { id } = await fundedBounty();
    await submissionsPost(
      post(`/api/bounties/${id}/submissions`, workerKey, {
        artifactUrl: "https://example.test/pr/1",
        rewardAddress: WORKER_WALLET,
      }, "post_sub_1"),
      params(id),
    );

    const agree = () =>
      agreePost(post(`/api/bounties/${id}/agree`, ownerKey, {}, "post_agree_1"), params(id));

    const first = await agree();
    const second = await agree();
    const firstBody = await first.json();
    const secondBody = await second.json();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(secondBody.idempotency.replayed).toBe(true);
    expect(firstBody.data.escrow.release.decidedAt).toBe(
      secondBody.data.escrow.release.decidedAt,
    );

    // Exactly one decision receipt, so the replay decided nothing a second time.
    const agreements = secondBody.receipts.filter(
      (r: { action: string }) => r.action === "owner_agree",
    );
    expect(agreements).toHaveLength(1);

    // Releasing twice moves the money once: the second call finds nothing left
    // to release rather than sending a second transfer.
    const release = (key: string) =>
      releasePost(post(`/api/bounties/${id}/release`, ownerKey, {}, key), params(id));

    const released = await release("post_release_1");
    expect((await released.json()).bounty.escrow.balance.minor).toBe("0");

    const again = await release("post_release_1b");
    expect(again.status).toBe(409);
    expect((await again.json()).error.code).toBe("invalid_state");

    // And a different key on the same settled bounty is refused outright.
    const retry = await agreePost(
      post(`/api/bounties/${id}/agree`, ownerKey, {}, "post_agree_2"),
      params(id),
    );
    expect(retry.status).toBe(409);
    expect((await retry.json()).error.code).toBe("escrow_settled");
  });

  it("rejects a key reused for a different request", async () => {
    await bountiesPost(
      post(
        "/api/bounties",
        ownerKey,
        {
          title: "One",
          brief: "First",
          amount: "$10.00",
          deadlineAt: new Date(Date.now() + HOUR).toISOString(),
        },
        "post_same",
      ),
    );
    const response = await bountiesPost(
      post(
        "/api/bounties",
        ownerKey,
        {
          title: "Two",
          brief: "Different",
          amount: "$20.00",
          deadlineAt: new Date(Date.now() + HOUR).toISOString(),
        },
        "post_same",
      ),
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("idempotency_conflict");
  });

  it("scopes keys per muse, so two muses can use the same post id", async () => {
    const { body: mine } = await createBounty({}, ownerKey);
    const { response } = await createBounty({}, workerKey);
    expect(response.status).toBe(201);
    expect(mine.bounty.creator).toBe(OWNER);
  });

  it("releases the key when the attempt failed, so a fixed retry works", async () => {
    const bad = await bountiesPost(
      post("/api/bounties", ownerKey, { title: "", brief: "", amount: "$1" }, "post_fix"),
    );
    expect(bad.status).toBe(400);

    const good = await bountiesPost(
      post(
        "/api/bounties",
        ownerKey,
        {
          title: "Fixed",
          brief: "Now valid",
          amount: "$5.00",
          deadlineAt: new Date(Date.now() + HOUR).toISOString(),
        },
        "post_fix",
      ),
    );
    expect(good.status).toBe(201);
  });
});

describe("responses carry complete receipt material", () => {
  it("returns the receipt chain with ids, amounts, actor and timestamps", async () => {
    const { body } = await createBounty();
    expect(body.receipt).toMatchObject({
      object: "receipt",
      action: "post",
      actor: OWNER,
      seq: 1,
    });
    expect(body.receipt.amount).toMatchObject({
      currency: "USD",
      minor: "25000",
      decimal: "250",
      display: "$250",
    });
    expect(body.receipt.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.receipt.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.bounty.escrow.txHash).toBeNull();
  });

  it("includes the payout receipt on the response that caused it", async () => {
    const { id } = await fundedBounty();
    await submissionsPost(
      post(`/api/bounties/${id}/submissions`, workerKey, {
        artifactUrl: "https://example.test/pr/1",
        rewardAddress: WORKER_WALLET,
      }, "post_sub_2"),
      params(id),
    );
    await disputePost(
      post(`/api/bounties/${id}/dispute`, ownerKey, { reason: "the artifact 404s" }, "post_dispute_2"),
      params(id),
    );

    let resolved: Record<string, unknown> | null = null;
    for (const [index, key] of councilKeys.slice(0, 2).entries()) {
      const response = await votePost(
        post(`/api/bounties/${id}/votes`, key, { choice: "pay" }, `post_vote_${index}`),
        params(id),
      );
      resolved = await response.json();
    }

    // The vote that reaches quorum decides; it does not pay. The response says
    // so, and says who may finish the job.
    const decided = resolved!.data as {
      escrow: { state: string; release: { payee: string; permissionless: boolean } };
    };
    expect(decided.escrow.state).toBe("releasable");
    expect(decided.escrow.release.payee).toBe(WORKER);
    expect(decided.escrow.release.permissionless).toBe(true);
    expect((resolved!.receipt as { action: string }).action).toBe("council_pay");

    // And anyone can finish it, because the decision was public.
    const released = await releasePost(
      post(`/api/bounties/${id}/release`, workerKey, {}, "post_release_2"),
      params(id),
    );
    const releasedBody = await released.json();
    expect(releasedBody.bounty.status).toBe("PAID");
    expect(releasedBody.bounty.escrow.settledTo).toBe(WORKER);
    expect(releasedBody.bounty.escrow.balance.minor).toBe("0");
  });
});

describe("polling surfaces are JSON with explicit enums", () => {
  it("lists bounties with status enums and ids", async () => {
    await createBounty();
    const body = await (await bountiesGet(get("/api/bounties?status=OPEN", ownerKey))).json();
    expect(body.object).toBe("list");
    // The spec's casing, verbatim, because agents branch on the exact string.
    expect(body.data[0]).toMatchObject({ object: "bounty", status: "OPEN" });
    expect(body.data[0].escrow.state).toBe("unfunded");
  });

  it("returns a coded error, never HTML, for a bad filter", async () => {
    const response = await bountiesGet(get("/api/bounties?status=sideways", ownerKey));
    expect(response.headers.get("content-type")).toContain("application/json");
    expect((await response.json()).error).toMatchObject({ code: "validation" });
  });
});

describe("slow work returns 202 plus a job to poll", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("accepts an answer, then reports the hash through the job", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("the answer is 42", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
      ),
    );

    const response = await answerPost(
      post(
        "/api/answer",
        workerKey,
        { subject: "post_8812", url: "https://example.test/answer" },
        "post_answer_1",
      ),
    );
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body.job.id).toBeTruthy();
    expect(body.answer.status).toBe("pending");
    expect(body.receipt.action).toBe("answer_submitted");

    await runJobNow(body.job.id);

    const job = await (await jobGet(get(`/api/jobs/${body.job.id}`, workerKey), params(body.job.id))).json();
    expect(job.status).toBe("succeeded");
    expect(job.result.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(job.result.status).toBe("verified");
  });

  it("reports an unreachable URL as a finished job, not a crash", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));

    const body = await (
      await answerPost(
        post(
          "/api/answer",
          workerKey,
          { subject: "post_1", url: "https://example.test/missing" },
          "post_answer_2",
        ),
      )
    ).json();
    await runJobNow(body.job.id);

    const job = await (await jobGet(get(`/api/jobs/${body.job.id}`, workerKey), params(body.job.id))).json();
    expect(job.status).toBe("succeeded");
    expect(job.result.status).toBe("unreachable");
  });

  it("hides another muse's job", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));
    const body = await (
      await answerPost(
        post("/api/answer", workerKey, { subject: "s", url: "https://example.test/a" }, "post_answer_3"),
      )
    ).json();

    const response = await jobGet(get(`/api/jobs/${body.job.id}`, ownerKey), params(body.job.id));
    expect(response.status).toBe(404);
  });
});

describe("the command ingest route", () => {
  it("publishes the directory without authentication", async () => {
    const body = await (await commandsGet()).json();
    expect(body.object).toBe("command_directory");
    expect(body.trigger).toBe("mention");
    expect(body.commands.map((c: { name: string }) => c.name)).toContain(
      "@bountyboard post",
    );
  });

  it("dispatches a command written as a sentence and returns its receipt", async () => {
    const response = await commandsPost(
      post(
        "/api/commands",
        ownerKey,
        { command: "@bountyboard post From a command | Ship it | $42 | 7d" },
        "post_cmd_1",
      ),
    );
    const body = await response.json();
    expect(body.object).toBe("acknowledgement");
    expect(body.ok).toBe(true);
    expect(body.command).toBe("@bountyboard post");
    expect(body.receipt.action).toBe("post");
    expect(body.data.amount.minor).toBe("4200");
  });

  it("accepts a structured family and action, so a client need not render a string", async () => {
    const body = await (
      await commandsPost(
        post(
          "/api/commands",
          ownerKey,
          {
            family: "bountyboard",
            action: "post",
            body: "Structured | Ship it | $42 | 7d",
          },
          "post_cmd_struct",
        ),
      )
    ).json();
    expect(body.ok).toBe(true);
    expect(body.data.title).toBe("Structured");
  });

  it("is idempotent like every other POST", async () => {
    const request = () =>
      post("/api/commands", ownerKey, { command: "@greeter greet @ada" }, "post_cmd_2");
    await commandsPost(request());
    const body = await (await commandsPost(request())).json();
    expect(body.idempotency.replayed).toBe(true);
  });
});

describe("the scheduled deadline check", () => {
  it("refunds lapsed bounties and reports what it did", async () => {
    const { body } = await createBounty({
      deadlineAt: new Date(Date.now() + 1000).toISOString(),
    });
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const run = await (
      await deadlineCheckPost(
        new Request(`${BASE}/api/deadlines/check`, { method: "POST" }),
      )
    ).json();

    expect(run.object).toBe("scheduled_run");
    expect(run.deadlineSweep.refunded).toContain(body.bounty.id);
  });
});
