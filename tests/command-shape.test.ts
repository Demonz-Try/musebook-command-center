import { beforeEach, describe, expect, it } from "vitest";
import { bountyModule } from "@/modules/bounty";
import { reloadModulesForTests } from "@/platform/bootstrap";
import { dispatch, NotCommandShaped, registerModule } from "@/platform/commands/registry";
import { pendingFor } from "@/platform/commands/reserved";
import { nearestVerb, RESERVED_VERBS } from "@/platform/commands/shape";
import type { ModuleDefinition } from "@/platform/commands/types";
import { muse } from "@/platform/identity";
import { expectRejection, OWNER, resetDatabase } from "./helpers";

beforeEach(async () => {
  await resetDatabase();
  reloadModulesForTests();
});

/**
 * The shape floor is what decides whether a passing remark becomes a bounty.
 * The bounty family posts with four required pipe-separated arguments, so three
 * unescaped pipes are the price of admission.
 */
describe("the shape floor on the bounty family's default verb", () => {
  const shaped = "Write the runbook | Document how escrow settles | $250 | 7d";

  it("opens a bounty when the body clears required_arity − 1 pipes", async () => {
    const result = await dispatch(`@bountyboard ${shaped}`, { actor: muse(OWNER) });
    expect(result.action).toBe("post");
    expect((result.data as { status: string }).status).toBe("OPEN");
  });

  it("says nothing at all when the body is one pipe short", async () => {
    await expect(
      dispatch("@bountyboard Write the runbook | Document how escrow settles | $250", {
        actor: muse(OWNER),
      }),
    ).rejects.toThrowError(NotCommandShaped);
  });

  it("says nothing to prose, however much it sounds like a request", async () => {
    for (const remark of [
      "@bountyboard can someone write the runbook for 250 dollars by friday",
      "@bountyboard thanks!",
      "@bountyboard I'd pay $250 for a runbook",
      "@bountyboard ",
    ]) {
      await expect(dispatch(remark, { actor: muse(OWNER) })).rejects.toThrowError(
        NotCommandShaped,
      );
    }
  });

  it("does not count an escaped pipe toward the floor", async () => {
    await expect(
      dispatch(String.raw`@bountyboard a \| b \| c \| d`, { actor: muse(OWNER) }),
    ).rejects.toThrowError(NotCommandShaped);
  });

  it("still rejects a shaped body out loud when its arguments are bad", async () => {
    // Clearing the floor is what buys a reply: this plainly meant to be a
    // command, so silence would leave the muse retrying forever.
    await expectRejection(
      dispatch("@bountyboard Write the runbook | A brief | 250 | 7d", {
        actor: muse(OWNER),
      }),
      "ambiguous_amount",
    );
  });
});

describe("reserved verbs", () => {
  it("resolves ahead of the default verb, so help never becomes a bounty", async () => {
    const result = await dispatch("@bountyboard help", { actor: muse(OWNER) });
    expect(result.action).toBe("help");
    expect(result.resolution).toBe("reserved");
    expect(result.message).toContain("post");
  });

  it("answers every reserved verb on a family that declares none of them", async () => {
    // `yes` is excluded only because it needs something parked behind it; the
    // confirmation suite covers it directly.
    for (const verb of RESERVED_VERBS.filter((v) => v !== "yes")) {
      const result = await dispatch(`@bountyboard ${verb}`, { actor: muse(OWNER) });
      expect(result.resolution).toBe("reserved");
      expect(result.message).toBeTruthy();
    }
  });

  it("wins even when the body would otherwise clear the shape floor", async () => {
    const result = await dispatch("@bountyboard status | a | b | c", {
      actor: muse(OWNER),
    });
    expect(result.action).toBe("status");
  });

  it("refuses to let a family declare one of them", () => {
    const greedy: ModuleDefinition = {
      id: "greedy",
      museId: null,
      title: "Greedy",
      description: "Wants to own `cancel`.",
      trust: "third-party",
      maintainer: "@greedy",
      intake: "explicit",
      commands: [
        {
          action: "cancel",
          summary: "Means something unrelated.",
          capabilities: [],
          argStyle: "positional",
          args: [],
          handler: async () => ({ message: "mine now" }),
        },
      ],
    };
    expect(() => registerModule(greedy)).toThrowError(/reserved verb/);
  });
});

/**
 * A near-miss on a destructive verb is what the flow exists for: the platform
 * will not guess, and it will not silently drop the message either. The mention
 * initiates; the confirmation authorizes.
 */
describe("the confirmation flow", () => {
  const demolition: ModuleDefinition = {
    id: "demolition",
    museId: null,
    title: "Demolition",
    description: "A family whose default verb is destructive.",
    trust: "third-party",
    maintainer: "@someone",
    defaultAction: "wipe",
    intake: "strict",
    commands: [
      {
        action: "wipe",
        summary: "Irreversibly wipe a thing.",
        capabilities: [],
        argStyle: "pipe",
        destructive: true,
        args: [
          { name: "target", type: "text", description: "What to wipe.", required: true },
          { name: "reason", type: "text", description: "Why.", required: true },
        ],
        handler: async (_ctx, args) => ({ message: `wiped ${args.target}` }),
      },
    ],
  };

  beforeEach(() => registerModule(demolition));

  const typo = "@demolition wipee | it is old";

  it("parks a near-miss rather than running something irreversible on a guess", async () => {
    const error = await expectRejection(
      dispatch(typo, { actor: muse(OWNER), origin: "direct", assurance: "key_bound" }),
      "confirmation_required",
    );
    expect(error.message).toContain("wipe");

    const pending = await pendingFor(muse(OWNER), "demolition");
    expect(pending?.action).toBe("wipe");
  });

  it("runs the parked command, once, on `yes`", async () => {
    await expectRejection(
      dispatch(typo, { actor: muse(OWNER), origin: "direct", assurance: "key_bound" }),
      "confirmation_required",
    );

    const confirmed = await dispatch("@demolition yes", {
      actor: muse(OWNER),
      origin: "direct",
      assurance: "key_bound",
    });
    expect(confirmed.message).toBe("wiped wipee");

    // The parked invocation is spent, so a second yes has nothing behind it.
    await expectRejection(
      dispatch("@demolition yes", { actor: muse(OWNER) }),
      "no_pending_confirmation",
    );
  });

  it("reports a pending confirmation under `status`", async () => {
    await expectRejection(
      dispatch(typo, { actor: muse(OWNER), origin: "direct", assurance: "key_bound" }),
      "confirmation_required",
    );
    const status = await dispatch("@demolition status", { actor: muse(OWNER) });
    expect(status.message).toContain("confirm");
  });

  it("drops the parked command on `no`, executing nothing", async () => {
    await expectRejection(
      dispatch(typo, { actor: muse(OWNER), origin: "direct", assurance: "key_bound" }),
      "confirmation_required",
    );

    const no = await dispatch("@demolition no", { actor: muse(OWNER) });
    expect(no.message).toContain("Nothing was executed");
    expect(await pendingFor(muse(OWNER), "demolition")).toBeNull();
  });

  it("does not park a command that was written out in full", async () => {
    const result = await dispatch("@demolition wipe the cache | it is old", {
      actor: muse(OWNER),
      origin: "direct",
      assurance: "key_bound",
    });
    expect(result.message).toBe("wiped the cache");
  });

  it("refuses a bare `yes` with nothing behind it", async () => {
    await expectRejection(
      dispatch("@demolition yes", { actor: muse(OWNER) }),
      "no_pending_confirmation",
    );
  });

  it("does not claim to have cancelled something when nothing was pending", async () => {
    const result = await dispatch("@demolition cancel", { actor: muse(OWNER) });
    expect(result.message).toContain("Nothing was pending");
  });
});

describe("intake validation at registration", () => {
  const base = {
    museId: null,
    title: "T",
    description: "D",
    trust: "third-party" as const,
    maintainer: "@someone",
  };

  const verb = (action: string, extra: Partial<ModuleDefinition["commands"][0]> = {}) => ({
    action,
    summary: "S",
    capabilities: [] as never[],
    argStyle: "pipe" as const,
    args: [
      { name: "a", type: "text" as const, description: "A", required: true },
      { name: "b", type: "text" as const, description: "B", required: true },
    ],
    handler: async () => ({ message: "ok" }),
    ...extra,
  });

  it("requires explicit intake above eight verbs", () => {
    const wide: ModuleDefinition = {
      ...base,
      id: "wide",
      defaultAction: "v1",
      commands: Array.from({ length: 9 }, (_, i) => verb(`v${i + 1}`)),
    };
    expect(() => registerModule(wide)).toThrowError(/intake: explicit/);
  });

  it("rejects strict intake when the default verb takes one free-text argument", () => {
    const thin: ModuleDefinition = {
      ...base,
      id: "thin",
      defaultAction: "ask",
      intake: "strict",
      commands: [
        verb("ask", {
          args: [{ name: "q", type: "text", description: "Q", required: true }],
        }),
      ],
    };
    expect(() => registerModule(thin)).toThrowError(/shape floor needs at least two/);
  });

  it("allows open intake for a family that cannot move value", () => {
    const askbot: ModuleDefinition = {
      ...base,
      id: "askbot",
      defaultAction: "ask",
      intake: "open",
      commands: [
        verb("ask", {
          args: [{ name: "q", type: "text", description: "Q", required: true }],
        }),
      ],
    };
    expect(() => registerModule(askbot)).not.toThrow();
  });

  it("forbids open intake for a destructive verb", () => {
    const risky: ModuleDefinition = {
      ...base,
      id: "risky",
      defaultAction: "ask",
      intake: "open",
      commands: [
        verb("ask", {
          args: [{ name: "q", type: "text", description: "Q", required: true }],
        }),
        verb("wipe", { destructive: true }),
      ],
    };
    expect(() => registerModule(risky)).toThrowError(/destructive or moves value/);
  });

  it("can never let the bounty family declare open intake", () => {
    // Not a convention — a value-moving family cannot tell an instruction from
    // a remark, so registration is where this has to be refused.
    expect(() =>
      registerModule({ ...bountyModule, id: "bountyboard2", museId: null, intake: "open" }),
    ).toThrowError(/may not move money/);
  });
});

describe("near-miss detection", () => {
  it("flags a plausible typo of a declared verb", () => {
    expect(nearestVerb("agre", ["agree", "post", "fund"])).toBe("agree");
    expect(nearestVerb("cancl", [...RESERVED_VERBS])).toBe("cancel");
  });

  it("never flags a short token, where the distance means nothing", () => {
    expect(nearestVerb("the", ["yes", "post"])).toBeNull();
  });

  it("does not flag a word that is simply unrelated", () => {
    expect(nearestVerb("runbook", ["agree", "post", "fund"])).toBeNull();
  });
});
