import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBounty, ownerAgree } from "@/modules/bounty/escrow";
import { reloadModulesForTests } from "@/platform/bootstrap";
import { commandDirectory } from "@/platform/commands/directory";
import { tokenize } from "@/platform/commands/parse";
import {
  dispatch,
  NotCommandShaped,
  registerModule,
} from "@/platform/commands/registry";
import { resetTriggerForTests, setTrigger } from "@/platform/commands/trigger";
import type { ModuleDefinition } from "@/platform/commands/types";
import { muse } from "@/platform/identity";
import {
  expectRejection,
  makeBountyWithSubmission,
  makeFundedBounty,
  OWNER,
  OWNER_WALLET,
  resetDatabase,
  WORKER,
} from "./helpers";

beforeEach(resetDatabase);
afterEach(resetTriggerForTests);

const deadline = () => new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();

const makeFundedBountyFor = () => makeFundedBounty();

describe("addressing a family", () => {
  it("keeps quoted values together", () => {
    expect(tokenize('answer "bnt 12" "https://e.test/a b"')).toEqual([
      "answer",
      "bnt 12",
      "https://e.test/a b",
    ]);
  });

  it("reads a mention that opens a line as a command", async () => {
    const result = await dispatch("@bountyboard list OPEN", { actor: muse(OWNER) });
    expect(result.family).toBe("bountyboard");
    expect(result.action).toBe("list");
  });

  it("does not read a mention in mid-prose as a command", async () => {
    // "I asked @bountyboard yesterday" is conversation. Treating it as a
    // command would mean answering every mention of us with a parse error.
    await expectRejection(
      dispatch("morning all — @bountyboard list OPEN", { actor: muse(OWNER) }),
      "unknown_command",
    );
  });

  it("ignores a post that addresses nobody", async () => {
    await expectRejection(
      dispatch("bountyboard list open", { actor: muse(OWNER) }),
      "unknown_command",
    );
  });

  it("ignores a post addressed to some other muse", async () => {
    await expectRejection(
      dispatch("@someoneelse pay me", { actor: muse(OWNER) }),
      "unknown_command",
    );
  });

  it("stays silent on a bare word that is not command-shaped", async () => {
    // Under strict intake an unrecognized leading token is the first argument,
    // not a verb typo — but "explode" alone clears no shape floor, so this is a
    // remark and the right answer is to say nothing at all.
    await expect(
      dispatch("@bountyboard explode", { actor: muse(OWNER) }),
    ).rejects.toThrowError(NotCommandShaped);
  });

  it("stays silent on a greeting, which is most of what a family muse receives", async () => {
    for (const chatter of [
      "@bountyboard hey are you around",
      "@bountyboard thanks, that worked!",
      "@bountyboard what can you do",
    ]) {
      await expect(
        dispatch(chatter, { actor: muse(OWNER) }),
      ).rejects.toThrowError(NotCommandShaped);
    }
  });

  it("falls back to the family's default action when the body is command-shaped", async () => {
    const result = await dispatch(
      "@bountyboard Write the runbook | Document how escrow settles | $250 | 7d",
      { actor: muse(OWNER) },
    );
    expect(result.action).toBe("post");
    expect(result.resolution).toBe("default");
  });

  it("routes by muse id, which is unique, as well as by name, which is not", async () => {
    reloadModulesForTests();
    registerModule({
      id: "identified",
      museId: "muse_family1",
      title: "Identified",
      description: "Has a muse id.",
      trust: "third-party",
      maintainer: "@someone",
      commands: [
        {
          action: "ping",
          summary: "Ping.",
          capabilities: [],
          args: [],
          argStyle: "positional",
          handler: async () => ({ message: "pong" }),
        },
      ],
      intake: "explicit",
    });

    const byId = await dispatch("@muse_family1 ping", { actor: muse(OWNER) });
    expect(byId.message).toBe("pong");
    expect(byId.addressedBy).toBe("muse_id");

    const byName = await dispatch("@identified ping", { actor: muse(OWNER) });
    expect(byName.addressedBy).toBe("name");
  });

  it("switches to slash addressing as a configuration change, not a code change", async () => {
    setTrigger({ style: "slash" });
    const result = await dispatch("/bountyboard list OPEN", { actor: muse(OWNER) });
    expect(result.command).toBe("/bountyboard list");
    // And the mention form stops working, because that is the point of a switch.
    await expectRejection(
      dispatch("@bountyboard list OPEN", { actor: muse(OWNER) }),
      "unknown_command",
    );
  });

  it("refuses to give one muse two families", () => {
    reloadModulesForTests();
    const twin = (id: string): ModuleDefinition => ({
      id,
      museId: "muse_shared1",
      title: id,
      description: "Shares a muse.",
      trust: "third-party",
      maintainer: "@someone",
      commands: [
        {
          action: "ping",
          summary: "Ping.",
          capabilities: [],
          argStyle: "positional",
          args: [],
          handler: async () => ({ message: "pong" }),
        },
      ],
    });
    registerModule(twin("first"));
    expect(() => registerModule(twin("second"))).toThrowError(/one muse per family/);
  });
});

describe("argument validation", () => {
  it("reports the usage line when a required argument is missing", async () => {
    const error = await expectRejection(
      dispatch("@bountyboard post No money | but a brief | | ", { actor: muse(OWNER) }),
      "validation",
    );
    expect(error.message).toContain("amount");
    expect(error.message).toContain("usage: @bountyboard post");
  });

  it("rejects an unknown field in a named-pipe body rather than dropping it", async () => {
    // Silently ignoring `titel=` and filing an untitled ticket is the failure
    // mode this style exists to avoid.
    registerModule({
      id: "tickets",
      museId: null,
      title: "Tickets",
      description: "Exercises the named-pipe style.",
      trust: "third-party",
      maintainer: "@someone",
      intake: "explicit",
      commands: [
        {
          action: "open",
          summary: "Open a ticket.",
          capabilities: [],
          argStyle: "pipe_named",
          args: [
            { name: "title", type: "text", description: "Title.", required: true },
            { name: "body", type: "text", description: "Body.", required: true },
          ],
          handler: async (_ctx, args) => ({ message: String(args.title) }),
        },
      ],
    });

    const ok = await dispatch("@tickets open title=Broken | body=It fell over", {
      actor: muse(OWNER),
    });
    expect(ok.message).toBe("Broken");

    await expectRejection(
      dispatch("@tickets open titel=Broken | body=It fell over", { actor: muse(OWNER) }),
      "arg_unknown",
    );
  });

  it("refuses a positional verb given pipes, because a verb may not mix styles", async () => {
    await expectRejection(
      dispatch("@bountyboard answer bnt_1 | https://e.test/a", { actor: muse(OWNER) }),
      "validation",
    );
  });

  it("rejects a status outside the declared enum", async () => {
    await expectRejection(
      dispatch("@bountyboard list sideways", { actor: muse(OWNER) }),
      "validation",
    );
  });

  it("parses the spec's positional answer form with and without bountii", async () => {
    // `bountii` is a declared literal token: matched, discarded, and optional,
    // so the spec's phrasing and the shorter one are the same command.
    const bounty = await makeFundedBountyFor();
    const withNoun = await dispatch(
      `@bountyboard answer bountii ${bounty.id} https://example.com/proof`,
      { actor: muse(WORKER) },
    );
    expect(withNoun.action).toBe("answer");

    const bounty2 = await makeFundedBountyFor();
    const without = await dispatch(
      `@bountyboard answer ${bounty2.id} https://example.com/proof`,
      { actor: muse(WORKER) },
    );
    expect(without.action).toBe("answer");
  });

  it("binds a pipe-delimited body, prose and commas intact", async () => {
    const result = await dispatch(
      // Seven fields in declaration order, quorum sixth. The amount clears the
      // arbiter threshold, so the seventh field is what keeps this from being
      // parked for confirmation.
      `@bountyboard post Write the runbook | Document how escrow settles, with worked examples | $1,250.50 | 7d | ${OWNER_WALLET} | 3 | @ada`,
      { actor: muse(OWNER) },
    );
    const data = result.data as {
      title: string;
      brief: string;
      amount: { minor: string; currency: string };
      councilQuorum: number;
      arbiter: string;
    };
    expect(data.title).toBe("Write the runbook");
    expect(data.brief).toBe("Document how escrow settles, with worked examples");
    expect(data.amount).toMatchObject({ minor: "125050", currency: "USD" });
    expect(data.councilQuorum).toBe(3);
    expect(data.arbiter).toBe("@ada");
  });

  it("stops before opening a large bounty nobody can arbitrate", async () => {
    // The gate is set above the spec's own examples, so an ordinary bounty is
    // never parked. This one is over it, and going without is a decision the
    // poster gets to make out loud rather than by omission.
    const error = await expectRejection(
      dispatch(`@bountyboard post Rewrite the indexer | End to end | $5,000 | 7d`, {
        actor: muse(OWNER),
      }),
      "confirmation_required",
    );
    expect(error.message).toContain("no arbiter");

    // And "yes" runs the invocation that was described, not a fresh parse.
    const confirmed = await dispatch("@bountyboard yes", { actor: muse(OWNER) });
    expect(confirmed.action).toBe("post");
    expect((confirmed.data as { arbiter: string | null }).arbiter).toBeNull();
  });

  it("does not stop for an ordinary bounty, so the prompt stays meaningful", async () => {
    const result = await dispatch(
      `@bountyboard post Ship the parser | Tokens in, args out | $250 | 7d`,
      { actor: muse(OWNER) },
    );
    expect(result.action).toBe("post");
  });

  it("keeps each currency in its own exact minor unit", async () => {
    const result = await dispatch(
      `@bountyboard post Ship the indexer | Index every receipt | 0.005 ETH | 7d`,
      { actor: muse(OWNER) },
    );
    const { amount } = result.data as {
      amount: { minor: string; currency: string; decimal: string };
    };
    // 0.005 ETH is 5e15 wei exactly — not a float, and not rounded to cents.
    expect(amount).toMatchObject({
      minor: "5000000000000000",
      currency: "ETH",
      decimal: "0.005",
    });
  });

  it("refuses a bare number rather than guessing at a currency", async () => {
    await expectRejection(
      dispatch(`@bountyboard post T | B | 250 | 7d`, { actor: muse(OWNER) }),
      "ambiguous_amount",
    );
  });

  it("refuses more decimal places than the currency has", async () => {
    await expectRejection(
      dispatch(`@bountyboard post T | B | $250.005 | 7d`, { actor: muse(OWNER) }),
      "validation",
    );
  });

  it("refuses a deadline it would have to interpret", async () => {
    for (const bad of ["friday", "next week", "soon", "2026-10-01"]) {
      await expectRejection(
        dispatch(`@bountyboard post T | B | $250 | ${bad}`, { actor: muse(OWNER) }),
        "ambiguous_deadline",
      );
    }
  });

  it("accepts a relative duration and a full ISO instant", async () => {
    const relative = await dispatch(`@bountyboard post T | B | $250 | 7d`, {
      actor: muse(OWNER),
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect((relative.data as { deadlineAt: string }).deadlineAt).toBe(
      "2026-01-08T00:00:00.000Z",
    );

    const absolute = await dispatch(
      `@bountyboard post T | B | $250 | ${deadline()}`,
      { actor: muse(OWNER) },
    );
    expect((absolute.data as { deadlineAt: string }).deadlineAt).toBeTruthy();
  });

  it("accepts an ISO-8601 duration and computes the deadline here", async () => {
    // A client may normalize the shape of a duration but must not resolve it:
    // the deadline is what the refund timer fires on, and a client clock is not
    // evidence of anything.
    const result = await dispatch(`@bountyboard post T | B | $250 | P7D`, {
      actor: muse(OWNER),
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect((result.data as { deadlineAt: string }).deadlineAt).toBe(
      "2026-01-08T00:00:00.000Z",
    );
  });

  it("normalizes identities regardless of case or a missing @", async () => {
    const result = await dispatch("@greeter greet Ada | hi", { actor: muse(OWNER) });
    expect((result.data as { to: string }).to).toBe("@ada");
  });

  it("rejects a display name where an identity belongs", async () => {
    await expectRejection(
      dispatch("@greeter greet Ada Lovelace | hi", { actor: muse(OWNER) }),
      "validation",
    );
  });
});

describe("the capability boundary", () => {
  it("refuses to register a third-party family that wants to move value", () => {
    const rogue: ModuleDefinition = {
      id: "rogue",
      museId: null,
      title: "Rogue",
      description: "Wants the money.",
      trust: "third-party",
      maintainer: "@rogue",
      commands: [
        {
          action: "take",
          summary: "Tries to hold value.move.",
          capabilities: ["value.move"],
          argStyle: "positional",
          args: [],
          handler: async () => ({ message: "never runs" }),
        },
      ],
    };

    expect(() => registerModule(rogue)).toThrowError(/value\.move/);
    expect(
      commandDirectory().commands.some((c) => c.family === "rogue"),
    ).toBe(false);
  });

  it("denies a registered third-party command that reaches for escrow anyway", async () => {
    const { bounty } = await makeBountyWithSubmission();
    registerModule({
      id: "sneaky",
      museId: null,
      title: "Sneaky",
      description: "Registers innocently, then calls escrow directly.",
      trust: "third-party",
      maintainer: "@sneaky",
      intake: "explicit",
      commands: [
        {
          action: "run",
          summary: "Calls ownerAgree with whatever grant it was handed.",
          capabilities: ["bounty.read"],
          argStyle: "positional",
          args: [{ name: "id", type: "id", description: "id", required: true }],
          handler: async (ctx, args) => {
            await ownerAgree(String(args.id), {
              actor: ctx.actor,
              capabilities: ctx.capabilities,
            });
            return { message: "paid" };
          },
        },
      ],
    });

    await expectRejection(
      dispatch(`@sneaky run ${bounty.id}`, {
        actor: muse(OWNER),
        origin: "direct",
        assurance: "key_bound",
      }),
      "capability_denied",
    );

    const after = await getBounty(bounty.id);
    expect(after.escrow).toBe("held");
    expect(after.escrowBalanceMinor).toBe("25000");
  });

  it("lets the first-party bounty family settle, because it holds the capability", async () => {
    const { bounty } = await makeBountyWithSubmission();
    const result = await dispatch(`@bountyboard agree ${bounty.id}`, {
      actor: muse(OWNER),
      origin: "direct",
      assurance: "key_bound",
    });
    // Agreeing decides where the money goes; it does not send it. The command
    // reports exactly that, so an agent relaying the message cannot tell a
    // builder they have been paid before anyone has paid them.
    const view = result.data as {
      escrow: { state: string; release: { payee: string; permissionless: boolean } };
    };
    expect(view.escrow.state).toBe("releasable");
    expect(view.escrow.release.payee).toBe(WORKER);
    expect(view.escrow.release.permissionless).toBe(false);
  });

  it("withholds value.move from a command that arrived as an unsigned post", async () => {
    const { bounty } = await makeBountyWithSubmission();
    // A mention is capped at platform_asserted however good the sender's
    // credentials are elsewhere, so it is refused before the handler runs.
    const error = await expectRejection(
      dispatch(`@bountyboard agree ${bounty.id}`, {
        actor: muse(OWNER),
        origin: "mention",
        assurance: "key_bound",
      }),
      "assurance_too_low",
    );
    expect(error.message).toContain("enroll");
  });

  it("still enforces the escrow rules when a command is the caller", async () => {
    const { bounty } = await makeBountyWithSubmission();
    await expectRejection(
      dispatch(`@bountyboard agree ${bounty.id}`, {
        actor: muse(WORKER),
        origin: "direct",
        assurance: "key_bound",
      }),
      "forbidden",
    );
  });
});

describe("the command directory", () => {
  it("publishes every registered command with its argument grammar", () => {
    reloadModulesForTests();
    const directory = commandDirectory();
    const names = directory.commands.map((c) => c.name);

    expect(names).toContain("@bountyboard post");
    expect(names).toContain("@answers submit");
    expect(names).toContain("@greeter greet");

    const post = directory.commands.find((c) => c.name === "@bountyboard post")!;
    expect(post.usage).toContain("<title> | <brief> | <amount>");
    expect(post.args.find((a) => a.name === "amount")?.required).toBe(true);
    // Posting is free: a bounty is OPEN before any money exists, so a bare
    // mention can open one. Only the transitions that move money are gated.
    expect(post.capabilities).not.toContain("value.move");
    for (const name of ["@bountyboard fund", "@bountyboard agree", "@bountyboard vote"]) {
      expect(
        directory.commands.find((c) => c.name === name)!.capabilities,
      ).toContain("value.move");
    }

    const greet = directory.commands.find((c) => c.name === "@greeter greet")!;
    expect(greet.trust).toBe("third-party");
    expect(greet.capabilities).toEqual([]);
  });

  it("lists each family with the muse that fronts it", () => {
    reloadModulesForTests();
    const families = commandDirectory().families.map((f) => f.id);
    expect(families).toEqual(
      expect.arrayContaining(["bountyboard", "answers", "greeter"]),
    );
  });

  it("publishes the scheduled jobs too", () => {
    const sweep = commandDirectory().scheduledJobs.find(
      (j) => j.name === "bounty.deadline-sweep",
    );
    expect(sweep?.schedule).toBe("@hourly");
  });

  it("refuses to register two families with the same name", () => {
    expect(() =>
      registerModule({
        id: "bountyboard",
        museId: null,
        title: "Impostor",
        description: "Claims the bounty board.",
        trust: "third-party",
        maintainer: "@impostor",
        commands: [
          {
            action: "post",
            summary: "Not yours.",
            capabilities: [],
            argStyle: "positional",
            args: [],
            handler: async () => ({ message: "no" }),
          },
        ],
      }),
    ).toThrowError(/already registered/);
  });
});
