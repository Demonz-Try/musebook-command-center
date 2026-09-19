import { describe, expect, it, vi } from "vitest";
import {
  DryRunRouter,
  RouterHttpClient,
  idempotencyKeyFor,
  type InvocationRequest,
  type InvokeResult,
  toResult,
  type RouterApi,
} from "../src/backend/client.js";
import { loadConfig } from "../src/config.js";
import { createState } from "../src/ingest/state.js";
import { MemoryStateStore } from "../src/ingest/store.js";
import type { MusebookClient } from "../src/musebook/client.js";
import { Agent } from "../src/runtime/agent.js";
import { silentLogger } from "../src/runtime/logger.js";

const MUSE_ID = "muse_agent0001";
/** A valid EIP-55 checksummed address, from the EIP's own reference list. */
const ADDRESS = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const COMMAND = `@bountydesk post | recipe site | one page, mobile first | 0.005 ETH | 7d | ${ADDRESS}`;

/** A musebook stand-in recording every write the agent makes. */
function fakeMusebook(options: {
  mentions: { postId: number; channel: string }[];
  post: { id: number; text: string; channel: string; museId?: string; idVerified?: boolean };
  failReplyTimes?: number;
  failReactTimes?: number;
}) {
  const posted: { text: string; parentPostId: number | null }[] = [];
  const reacted: { postId: number; emoji: string }[] = [];
  let replyFailures = options.failReplyTimes ?? 0;
  let reactFailures = options.failReactTimes ?? 0;

  const client = {
    getMentions: vi.fn(async () => ({
      unread: options.mentions.length,
      mentions: options.mentions.map((mention) => ({
        postId: mention.postId,
        channel: mention.channel,
        fromMuseId: "muse_caller0001",
        fromName: "Caller",
        createdAt: "2026-09-19 10:00:00",
        // Truncated, exactly as the real inbox returns it.
        excerpt: options.post.text.slice(0, 200),
      })),
    })),
    getLatest: vi.fn(async () => [
      {
        id: options.post.id,
        channel: options.post.channel,
        text: options.post.text,
        name: "Caller",
        muse_id: options.post.museId ?? "muse_caller0001",
        parent_post_id: null,
        created_at: "2026-09-19 10:00:00",
        reply_count: 0,
        id_verified: options.post.idVerified ?? true,
        founder: false,
        avatar_url: null,
      },
    ]),
    getThread: vi.fn(async () => []),
    react: vi.fn(async (postId: number, emoji: string) => {
      if (reactFailures > 0) {
        reactFailures -= 1;
        throw new Error("musebook said no");
      }
      reacted.push({ postId, emoji });
      return { reacted: true, counts: { [emoji]: 1 } };
    }),
    createPost: vi.fn(async (input: { text: string; parentPostId?: number | null }) => {
      if (replyFailures > 0) {
        replyFailures -= 1;
        throw new Error("musebook said no");
      }
      posted.push({ text: input.text, parentPostId: input.parentPostId ?? null });
      return { id: 99_000 + posted.length, channel: options.post.channel, parent_post_id: null };
    }),
  };

  return { client: client as unknown as MusebookClient, posted, reacted };
}

function recordingRouter(
  behaviour: (call: number) => InvokeResult,
): RouterApi & { calls: InvocationRequest[] } {
  const calls: InvocationRequest[] = [];
  return {
    calls,
    async invoke(request: InvocationRequest) {
      calls.push(request);
      return behaviour(calls.length);
    },
    async getJob() {
      return okResult;
    },
  };
}

const okResult: InvokeResult = {
  kind: "settled",
  status: "succeeded",
  deduped: false,
  warnings: [],
  ack: { tier: "reply", kind: "succeeded", text: "bounty 12 is OPEN — 0.005 ETH, due in 7d." },
};

async function buildAgent(options: {
  musebook: MusebookClient;
  router: RouterApi;
  watermark?: number;
  maxAttempts?: number;
  boardWritesPerHour?: number;
  reactionsCountAgainstBudget?: boolean;
  state?: ReturnType<typeof createState>;
}) {
  const base = await loadConfig({ family: "bounty", dryRun: false });
  const state = options.state ?? createState("bounty", MUSE_ID);
  if (!options.state) {
    state.watermark = options.watermark ?? 1000;
    state.highestSeenId = state.watermark;
  }
  const store = new MemoryStateStore(state);
  const agent = new Agent({
    config: {
      ...base,
      museId: MUSE_ID,
      dryRun: false,
      maxAttempts: options.maxAttempts ?? 5,
      boardWritesPerHour: options.boardWritesPerHour ?? 16,
      reactionsCountAgainstBudget: options.reactionsCountAgainstBudget ?? false,
      site: { baseUrl: "https://example.test/api/v1", token: "t" },
      enrollUrl: "https://example.test/enroll",
    },
    musebook: options.musebook,
    router: options.router,
    store,
    logger: silentLogger,
  });
  await agent.init();
  return { agent, state };
}

describe("idempotency key", () => {
  it("is the immutable musebook post id, in the router's format", () => {
    expect(idempotencyKeyFor(20_199)).toBe("mb_post:20199");
  });

  it("is stable across runs and distinct per post", () => {
    expect(idempotencyKeyFor(1)).toBe(idempotencyKeyFor(1));
    expect(idempotencyKeyFor(1)).not.toBe(idempotencyKeyFor(2));
  });

  it("travels as both a header and a body field", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ status: "succeeded" }), { status: 200 }),
    );
    const client = new RouterHttpClient({
      baseUrl: "https://example.test/api/v1",
      token: "secret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.invoke({
      family: "bounty",
      verb: "post",
      verb_resolution: "explicit",
      args: {},
      raw_args: {},
      raw_text: "…",
      actor: { muse_id: "muse_x", name: "x", public_key_present: true, id_verified: true },
      origin: {
        ingest: "mention_inbox",
        musebook_post_id: 5,
        musebook_parent_post_id: null,
        channel: "lobby",
        posted_at: null,
        observed_at: "2026-09-19T10:00:00.000Z",
        permalink: "https://musebook.lol/p/5",
      },
      idempotency_key: "mb_post:5",
    });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://example.test/api/v1/invoke");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["idempotency-key"]).toBe("mb_post:5");
    expect(JSON.parse((init as RequestInit).body as string).idempotency_key).toBe("mb_post:5");
  });
});

describe("never double-acting", () => {
  const mention = { postId: 1042, channel: "lobby" };
  const post = { id: 1042, text: COMMAND, channel: "lobby" };

  it("invokes once and replies once for a single mention", async () => {
    const { client, posted } = fakeMusebook({ mentions: [mention], post });
    const router = recordingRouter(() => okResult);
    const { agent } = await buildAgent({ musebook: client, router });

    await agent.tick();
    expect(router.calls).toHaveLength(1);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.parentPostId).toBe(1042);
  });

  it("does not act again when the same mention is redelivered", async () => {
    const { client, posted } = fakeMusebook({ mentions: [mention], post });
    const router = recordingRouter(() => okResult);
    const { agent } = await buildAgent({ musebook: client, router });

    await agent.tick();
    await agent.tick();
    await agent.tick();

    expect(router.calls).toHaveLength(1);
    expect(posted).toHaveLength(1);
  });

  it("does not re-invoke after a crash between the call and the reply", async () => {
    const { client, posted } = fakeMusebook({ mentions: [mention], post, failReplyTimes: 1 });
    const router = recordingRouter(() => okResult);
    const { agent, state } = await buildAgent({ musebook: client, router });

    await agent.tick();
    // The site acted; the board reply did not land.
    expect(router.calls).toHaveLength(1);
    expect(posted).toHaveLength(0);
    expect(state.posts["1042"]?.settled).toBe(true);

    state.posts["1042"]!.nextAttemptAt = 0;
    await agent.tick();

    // Second pass finishes the acknowledgement without a second invocation.
    expect(router.calls).toHaveLength(1);
    expect(state.posts["1042"]?.status).toBe("done");
  });

  it("re-sends but never double-acts after a restart that lost the acknowledgement", async () => {
    // Both board writes fail, so the invocation settles with no signal to the
    // author and the work stays outstanding across the restart.
    const first = fakeMusebook({ mentions: [mention], post, failReplyTimes: 99, failReactTimes: 99 });
    const router = recordingRouter(() => okResult);
    const { agent, state } = await buildAgent({ musebook: first.client, router });
    await agent.tick();

    expect(router.calls).toHaveLength(1);
    expect(state.posts["1042"]?.settled).toBe(true);
    expect(state.posts["1042"]?.status).toBe("retry");
    // Unfinished work pins the watermark below itself, so a restart re-runs it.
    expect(state.watermark).toBe(1041);

    // Restart: only what was persisted survives, and the board now works.
    const revived = JSON.parse(JSON.stringify(state));
    expect(revived.posts["1042"].idempotencyKey).toBe("mb_post:1042");
    revived.posts["1042"].nextAttemptAt = 0;

    const second = fakeMusebook({ mentions: [mention], post });
    const { agent: resumed } = await buildAgent({
      musebook: second.client,
      router,
      state: revived,
    });
    await resumed.tick();

    // The invocation is re-sent — that is how the site's acknowledgement text
    // is recovered — but under the identical key, so the site recognises a
    // replay instead of opening a second bounty.
    expect(router.calls).toHaveLength(2);
    expect(router.calls[0]!.idempotency_key).toBe(router.calls[1]!.idempotency_key);
    expect(router.calls[1]!.idempotency_key).toBe("mb_post:1042");
    expect(second.posted).toHaveLength(1);
  });

  it("goes silent instead of spamming after repeated internal failure", async () => {
    const { client, posted } = fakeMusebook({ mentions: [mention], post });
    const router = recordingRouter(() => ({
      kind: "error",
      retryable: true,
      code: "upstream_unavailable",
      userMessage: "unavailable",
    }));
    const { agent, state } = await buildAgent({ musebook: client, router, maxAttempts: 3 });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const record = state.posts["1042"];
      if (record) record.nextAttemptAt = 0;
      await agent.tick();
    }

    expect(state.posts["1042"]?.status).toBe("abandoned");
    // Not one public word about our own outage.
    expect(posted).toHaveLength(0);
    expect(router.calls.length).toBeLessThanOrEqual(3);
  });

  it("polls a job rather than re-invoking when the site returns 202", async () => {
    const { client } = fakeMusebook({ mentions: [mention], post });
    const router: RouterApi & { calls: InvocationRequest[]; jobPolls: number } = {
      calls: [],
      jobPolls: 0,
      async invoke(request) {
        this.calls.push(request);
        return { kind: "pending", job: { jobId: "job_1", pollAfterMs: 1 } };
      },
      async getJob() {
        this.jobPolls += 1;
        return okResult;
      },
    };
    const { agent, state } = await buildAgent({ musebook: client, router });

    await agent.tick();
    expect(state.posts["1042"]?.jobId).toBe("job_1");

    state.posts["1042"]!.nextAttemptAt = 0;
    await agent.tick();

    expect(router.calls).toHaveLength(1);
    expect(router.jobPolls).toBe(1);
    expect(state.posts["1042"]?.status).toBe("done");
  });
});

describe("the inbox excerpt is never the payload", () => {
  it("re-fetches the full post before parsing", async () => {
    const longRequirements = "must be responsive, ".repeat(12);
    const text = `@bountydesk post | a genuinely long job title that eats the excerpt budget | ${longRequirements} | 0.005 ETH | 7d | ${ADDRESS}`;
    expect(text.length).toBeGreaterThan(200);

    const { client } = fakeMusebook({
      mentions: [{ postId: 1042, channel: "lobby" }],
      post: { id: 1042, text, channel: "lobby" },
    });
    const router = recordingRouter(() => okResult);
    const { agent } = await buildAgent({ musebook: client, router });

    await agent.tick();

    // Parsing the 200-char excerpt would have lost the reward and the deadline.
    expect(router.calls).toHaveLength(1);
    expect(router.calls[0]!.args.reward).toEqual({
      amount: "0.005",
      currency: "ETH",
      display: "0.005 ETH",
    });
    // The funding address sits past the cutoff too, and losing it would mean
    // recording the wrong wallet on an escrow.
    expect(router.calls[0]!.args.funding_address).toBe(ADDRESS);
    expect(router.calls[0]!.raw_text).toBe(text);
  });
});

describe("what the agent reports and what it refuses to decide", () => {
  it("passes identity facts through without judging them", async () => {
    const { client } = fakeMusebook({
      mentions: [{ postId: 1042, channel: "lobby" }],
      post: { id: 1042, text: COMMAND, channel: "lobby", museId: "anon:atlas", idVerified: false },
    });
    const router = recordingRouter(() => okResult);
    const { agent } = await buildAgent({ musebook: client, router });

    await agent.tick();

    // The agent reports; authorization is the site's call, always.
    expect(router.calls).toHaveLength(1);
    expect(router.calls[0]!.actor).toEqual({
      muse_id: "anon:atlas",
      name: "Caller",
      public_key_present: false,
      id_verified: false,
    });
  });

  it("tells the site how the verb was resolved", async () => {
    const { client } = fakeMusebook({
      mentions: [{ postId: 1042, channel: "lobby" }],
      post: { id: 1042, text: "@bountydesk cancel the old design | changed my mind", channel: "lobby" },
    });
    const router = recordingRouter(() => okResult);
    const { agent } = await buildAgent({ musebook: client, router });

    await agent.tick();
    expect(router.calls[0]!.verb).toBe("cancel");
    expect(router.calls[0]!.verb_resolution).toBe("ambiguous");
  });

  it("echoes the spec's status strings verbatim, casing included", async () => {
    const { client, posted } = fakeMusebook({
      mentions: [{ postId: 1042, channel: "lobby" }],
      post: { id: 1042, text: COMMAND, channel: "lobby" },
    });
    const router = recordingRouter(() => ({
      ...okResult,
      ack: {
        tier: "reply",
        kind: "succeeded",
        text: "bounty 12: OPEN → FUNDED. next: IN_REVIEW, then PAID or REFUNDED. DISPUTED if contested.",
      },
    }));
    const { agent } = await buildAgent({ musebook: client, router });

    await agent.tick();
    for (const status of ["OPEN", "FUNDED", "IN_REVIEW", "PAID", "REFUNDED", "DISPUTED"]) {
      expect(posted[0]!.text).toContain(status);
    }
  });
});

describe("silence, forced acknowledgement, and addresses at the agent level", () => {
  const mention = { postId: 1042, channel: "lobby" };

  /**
   * `wire` is the raw JSON body the site would return, decoded by the real
   * parser — so these tests exercise the actual response contract rather than
   * a hand-built result object.
   */
  async function run(text: string, wire?: Record<string, unknown>) {
    const musebook = fakeMusebook({ mentions: [mention], post: { id: 1042, text, channel: "lobby" } });
    const router = recordingRouter(() =>
      wire
        ? toResult({ status: "succeeded", ...wire })
        : okResult,
    );
    const { agent, state } = await buildAgent({ musebook: musebook.client, router });
    await agent.tick();
    return { ...musebook, router, state };
  }

  it("stays completely silent on a mention that is not command-shaped", async () => {
    const { posted, reacted, router, state } = await run("@bountydesk thanks, that worked!");
    expect(router.calls).toHaveLength(0);
    expect(posted).toHaveLength(0);
    expect(reacted).toHaveLength(0);
    expect(state.posts["1042"]?.status).toBe("ignored");
  });

  it("forwards a command it believes is malformed", async () => {
    const { router, state } = await run(
      `@bountydesk post | logo | vector | about 5 ETH | next friday | ${ADDRESS}`,
    );
    expect(router.calls).toHaveLength(1);
    // Advisory hints travel, but the platform decides.
    expect(router.calls[0]!.parse_hints?.map((hint) => hint.arg)).toEqual(
      expect.arrayContaining(["reward", "deadline"]),
    );
    expect(state.posts["1042"]?.status).toBe("done");
  });

  it("refuses a malformed wallet address without forwarding it", async () => {
    const { router, posted, state } = await run(
      "@bountydesk post | recipe site | reqs | 0.005 ETH | 7d | 0xdefinitelynotanaddress",
    );
    // Nothing reached the site: a wrong address loses money permanently.
    expect(router.calls).toHaveLength(0);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.text).toContain("wallet address");
    expect(posted[0]!.text).toContain("nothing was created");
    expect(state.posts["1042"]?.status).toBe("rejected");
  });

  it("echoes the recorded address back exactly as accepted", async () => {
    const { posted } = await run(
      `@bountydesk post | recipe site | reqs | 0.005 ETH | 7d | ${ADDRESS}`,
    );
    expect(posted).toHaveLength(1);
    expect(posted[0]!.text).toContain(`funding address recorded: ${ADDRESS}`);
  });

  it("does not repeat the address when the site already named it", async () => {
    const { posted } = await run(
      `@bountydesk post | recipe site | reqs | 0.005 ETH | 7d | ${ADDRESS}`,
      { acknowledgement: { tier: "reply", kind: "succeeded", text: `bounty 12 OPEN, fund from ${ADDRESS}` } },
    );
    const occurrences = posted[0]!.text.split(ADDRESS).length - 1;
    expect(occurrences).toBe(1);
  });

  it("forces a threaded reply on a near miss, naming the suspected verb", async () => {
    const { posted, reacted, router } = await run(
      `@bountydesk cancl the old design | reqs | 0.005 ETH | 7d | ${ADDRESS}`,
      { acknowledgement: { tier: "reaction", kind: "succeeded", text: "opened bounty 37" } },
    );
    // The site asked for a reaction; a 🚀 cannot tell a muse it just opened a
    // bounty titled "cancl the old design".
    expect(router.calls[0]!.near_miss).toMatchObject({ token: "cancl", suspected_verb: "cancel" });
    expect(posted).toHaveLength(1);
    expect(posted[0]!.text).toContain("cancel");
    expect(posted[0]!.text).toContain("opened bounty 37");
    expect(reacted.map((entry) => entry.emoji)).toContain("👀");
  });

  // A typo'd verb shifts every field by one, so the address slot ends up with
  // a deadline in it. Blaming the wallet alone would be actively misleading.
  it("names the suspected verb when a typo shifts the address out of its slot", async () => {
    const { posted, router } = await run(
      `@bountydesk cancl | bnt_4812 | reqs | 0.005 ETH | 7d | ${ADDRESS}`,
    );
    expect(router.calls).toHaveLength(0);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.text).toContain("wallet address");
    expect(posted[0]!.text).toContain("cancel");
  });

  // A submission that looks accepted but can never be paid is the worst
  // message this agent can send.
  it("says plainly when a payout address was declared but not proven", async () => {
    const { posted, reacted } = await run(
      `@bountydesk answer bountii 12 https://example.com/proof ${ADDRESS}`,
      {
        acknowledgement: { tier: "reaction", kind: "succeeded", text: "submission 12 is IN_REVIEW" },
        payout: { address: ADDRESS, proven: false },
      },
    );
    // The site asked for a reaction; an emoji cannot carry "not payable".
    expect(posted).toHaveLength(1);
    expect(posted[0]!.text).toContain("NOT PAYABLE YET");
    expect(posted[0]!.text).toContain("IN_REVIEW");
    expect(posted[0]!.text).toContain("EIP-191");
    expect(posted[0]!.text).toContain("on-chain");
    expect(reacted.map((entry) => entry.emoji)).toContain("👀");
  });

  it("prefers the site's own instructions for proving an address", async () => {
    const { posted } = await run(
      `@bountydesk answer bountii 12 https://example.com/proof ${ADDRESS}`,
      {
        acknowledgement: { tier: "reply", kind: "succeeded", text: "submission 12 is IN_REVIEW" },
        payout: { address: ADDRESS, proven: false, instructions: "sign at https://x.test/prove/12" },
      },
    );
    expect(posted[0]!.text).toContain("https://x.test/prove/12");
  });

  it("confirms a proven payout address without alarming anyone", async () => {
    const { posted } = await run(
      `@bountydesk answer bountii 12 https://example.com/proof ${ADDRESS}`,
      {
        acknowledgement: { tier: "reply", kind: "succeeded", text: "submission 12 is IN_REVIEW" },
        payout: { address: ADDRESS, proven: true, method: "eip191" },
      },
    );
    expect(posted[0]!.text).toContain("payout address proven");
    expect(posted[0]!.text).toContain("eip191");
    expect(posted[0]!.text).not.toContain("NOT PAYABLE");
  });

  // A musebook keypair reaches key_bound, which can dispute but cannot
  // release. A receipt must never read like a payment confirmation.
  it("never implies that agreeing on the board moved money", async () => {
    const { posted } = await run("@bountydesk status 12", {
      acknowledgement: { tier: "reply", kind: "succeeded", text: "bounty 12 moved to PAID-pending" },
      release_requires_evm_signature: true,
    });
    expect(posted[0]!.text).toContain("does not move the money");
    expect(posted[0]!.text).toContain("EVM key");
  });

  it("answers a reserved verb the family never declared", async () => {
    const { router, posted } = await run("@bountydesk stop");
    expect(router.calls).toHaveLength(1);
    expect(router.calls[0]!.verb).toBe("stop");
    expect(router.calls[0]!.verb_resolution).toBe("reserved");
    // Reserved verbs always get a reply, never just an emoji.
    expect(posted).toHaveLength(1);
  });

  it("never lets a reserved verb become a bounty title", async () => {
    const { router } = await run("@bountydesk help");
    expect(router.calls[0]!.verb).toBe("help");
    expect(router.calls[0]!.verb).not.toBe("post");
  });
});

describe("dry run", () => {
  it("records what it would send and never calls out", async () => {
    const router = new DryRunRouter();
    const result = await router.invoke({
      family: "bounty",
      verb: "post",
      verb_resolution: "default",
      args: { reward: { display: "0.005 ETH" } },
      raw_args: {},
      raw_text: "…",
      actor: { muse_id: "muse_x", name: "x", public_key_present: true, id_verified: true },
      origin: {
        ingest: "mention_inbox",
        musebook_post_id: 1,
        musebook_parent_post_id: null,
        channel: "lobby",
        posted_at: null,
        observed_at: "2026-09-19T10:00:00.000Z",
        permalink: "https://musebook.lol/p/1",
      },
      idempotency_key: "mb_post:1",
    });
    expect(router.calls).toHaveLength(1);
    expect(result.kind).toBe("settled");
  });

  it("writes nothing to musebook", async () => {
    const { client, posted, reacted } = fakeMusebook({
      mentions: [{ postId: 1042, channel: "lobby" }],
      post: { id: 1042, text: COMMAND, channel: "lobby" },
    });
    const base = await loadConfig({ family: "bounty", dryRun: true });
    const state = createState("bounty", MUSE_ID);
    state.watermark = 1000;
    state.highestSeenId = 1000;
    const agent = new Agent({
      config: { ...base, museId: MUSE_ID, dryRun: true },
      musebook: client,
      router: new DryRunRouter(),
      store: new MemoryStateStore(state),
      logger: silentLogger,
    });
    await agent.init();
    await agent.tick();

    expect(posted).toHaveLength(0);
    expect(reacted).toHaveLength(0);
    expect(state.posts["1042"]?.status).toBe("done");
  });
});
