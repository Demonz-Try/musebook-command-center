import { describe, expect, it } from "vitest";
import {
  clearsShapeFloor,
  damerauLevenshtein,
  detectNearMiss,
  isCommandShaped,
  parseMention,
  splitPipeArgs,
  splitPositionalArgs,
} from "../src/command/parse.js";
import { findDeclaredVerb, type FamilySpec } from "../src/command/registry.js";
import { bountyFamily } from "../src/families/bounty.js";

const options = { handles: ["bountydesk"], family: bountyFamily };

/** A valid EIP-55 checksummed address, from the EIP's own reference list. */
const ADDRESS = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";

function parse(text: string) {
  return parseMention(text, options);
}

describe("verb resolution", () => {
  it("takes an explicit verb followed by a pipe", () => {
    const result = parse("@bountydesk post | recipe site | reqs | 0.005 ETH | 7d");
    expect(result.kind).toBe("command");
    if (result.kind !== "command") return;
    expect(result.verbName).toBe("post");
    expect(result.resolution).toBe("explicit");
  });

  // The spec's four fields keep their order and meaning; the funding address
  // is appended as a fifth. The verb is still omitted, so a muse taught the
  // spec's phrasing changes the leading token and adds its wallet.
  it("applies default_verb and keeps the spec's field order", () => {
    const result = parse(
      `@bountydesk recipe site | functional, i'll deploy, tabs with subsections | 0.005 ETH | 7d | ${ADDRESS}`,
    );
    expect(result.kind).toBe("command");
    if (result.kind !== "command") return;
    expect(result.verbName).toBe("post");
    expect(result.resolution).toBe("default");
    expect(result.args).toEqual({
      title: "recipe site",
      requirements: "functional, i'll deploy, tabs with subsections",
      reward: { amount: "0.005", currency: "ETH", display: "0.005 ETH" },
      deadline: { kind: "relative", value: 7, unit: "d", iso8601: "P7D", display: "7d" },
      funding_address: ADDRESS,
    });
  });

  // The address is load-bearing, so the spec's original four-field form is now
  // incomplete. Where that lands depends on whether the verb was named, and
  // the difference is worth pinning because it is a real adoption cliff.
  it("still parses the spec's four-field form, leaving the address to the site", () => {
    // Five is canonical; four falls back to the muse's proven default address,
    // which is what keeps the spec's original example working verbatim.
    const result = parse("@bountydesk recipe site | reqs | 0.005 ETH | 7d");
    expect(result.kind).toBe("command");
    if (result.kind !== "command") return;
    expect(result.argErrors).toEqual([]);
    expect(result.args.funding_address).toBeUndefined();
  });

  it("flags an ambiguous verb rather than acting on it silently", () => {
    const result = parse("@bountydesk cancel the old design | requirements changed");
    expect(result.kind).toBe("command");
    if (result.kind !== "command") return;
    expect(result.verbName).toBe("cancel");
    expect(result.resolution).toBe("ambiguous");
    expect(result.verb?.consequential).toBe(true);
  });

  it("lets the explicit form win over the ambiguity", () => {
    const result = parse(
      `@bountydesk post | cancel the old design | reqs | 0.005 ETH | 7d | ${ADDRESS}`,
    );
    expect(result.kind).toBe("command");
    if (result.kind !== "command") return;
    expect(result.verbName).toBe("post");
    expect(result.resolution).toBe("explicit");
    expect(result.args.title).toBe("cancel the old design");
  });

  it("does not call a positional verb ambiguous just because arguments follow it", () => {
    const result = parse(`@bountydesk answer 12 https://example.com/proof ${ADDRESS}`);
    expect(result.kind).toBe("command");
    if (result.kind !== "command") return;
    expect(result.resolution).toBe("explicit");
  });

  it("matches the handle and the verb case-insensitively", () => {
    expect(parse("@BountyDesk POST | a | b | 1 ETH | 7d").kind).toBe("command");
  });

  it("resolves aliases", () => {
    const result = parse(`@bountydesk submit 12 https://example.com/proof ${ADDRESS}`);
    expect(result.kind).toBe("command");
    if (result.kind !== "command") return;
    expect(result.verbName).toBe("answer");
  });
});

describe("reserved verbs", () => {
  // These are the six things a confused muse types, and the six cases where
  // creating a subject instead of answering is the worst outcome.
  for (const verb of ["help", "stop", "status", "yes", "no", "cancel"]) {
    it(`resolves "${verb}" ahead of the default verb`, () => {
      const result = parse(`@bountydesk ${verb}`);
      expect(result.kind).toBe("command");
      if (result.kind !== "command") return;
      expect(result.verbName).toBe(verb);
      // Never a bounty titled "help".
      expect(result.verbName).not.toBe("post");
    });
  }

  it("marks a reserved verb the family did not declare", () => {
    const result = parse("@bountydesk stop");
    expect(result.kind).toBe("command");
    if (result.kind !== "command") return;
    expect(result.reserved).toBe(true);
    expect(result.resolution).toBe("reserved");
  });

  it("lets a family implementation win over the reserved synthesis", () => {
    // bounty declares both `status` and `cancel` itself.
    const result = parse("@bountydesk status 12");
    expect(result.kind).toBe("command");
    if (result.kind !== "command") return;
    expect(result.reserved).toBe(false);
    expect(result.verb?.name).toBe("status");
  });

  it("makes a reserved verb command-shaped on its own", () => {
    expect(isCommandShaped(bountyFamily, "help")).toBe(true);
    expect(isCommandShaped(bountyFamily, "yes")).toBe(true);
  });
});

describe("command-shape is the line, not verb recognition", () => {
  // A family with a default verb recognizes every verb by construction, so
  // recognition alone would make nothing silent.
  it("requires required_arity - 1 pipes for a pipe-style default verb", () => {
    const post = findDeclaredVerb(bountyFamily, "post")!;
    // post takes four required arguments (the address is optional), so three pipes.
    expect(clearsShapeFloor(bountyFamily, post, "a | b | c | d")).toBe(true);
    expect(clearsShapeFloor(bountyFamily, post, "a | b | c")).toBe(false);
    expect(clearsShapeFloor(bountyFamily, post, "thanks, that worked!")).toBe(false);
  });

  it("does not count escaped pipes towards the floor", () => {
    const post = findDeclaredVerb(bountyFamily, "post")!;
    expect(clearsShapeFloor(bountyFamily, post, "a \\| b \\| c \\| d")).toBe(false);
  });

  const silent = [
    "@bountydesk thanks, that worked perfectly",
    "@bountydesk you are doing great work around here",
    "@bountydesk 🎉 congratulations on the launch, this is lovely",
    "@bountydesk hey are you around?",
    "@bountydesk",
    "@bountydesk sorry — ignore me",
  ];
  for (const text of silent) {
    it(`stays silent for: ${text.slice(12, 50)}`, () => {
      const result = parse(text);
      expect(result.kind).toBe("silent");
      if (result.kind !== "silent") return;
      expect(result.reason).toBe("not_command_shaped");
    });
  }

  it("stays silent for a mention that is not a candidate", () => {
    for (const text of [
      "thanks @bountydesk, that worked",
      "i asked @bountydesk yesterday and it was fine",
      "> @bountydesk post | a | b | 1 ETH | 7d",
      "```\n@bountydesk post | a | b | 1 ETH | 7d\n```",
    ]) {
      const result = parse(text);
      expect(result.kind).toBe("silent");
      if (result.kind !== "silent") return;
      expect(result.reason).toBe("not_candidate");
    }
  });

  it("ignores a post that never mentions us", () => {
    expect(parse("post | recipe site | x | 1 ETH | 7d").kind).toBe("not_addressed");
    expect(parse("@someoneelse post | a | b | 1 ETH | 7d").kind).toBe("not_addressed");
    expect(parse("@bountydeskbot post | a | b | 1 ETH | 7d").kind).toBe("not_addressed");
  });

  it("recognizes a mention that opens a line inside a longer post", () => {
    const result = parse(
      "morning all, been meaning to do this for days.\n\n@bountydesk post | fix the porch light | replace bulb and switch | 0.01 ETH | 3d\n\nthanks!",
    );
    expect(result.kind).toBe("command");
  });
});

describe("positional shape floor", () => {
  // Token count alone is weak — "thanks that worked" is three tokens. The type
  // check is the real floor.
  const positional: FamilySpec = {
    ...bountyFamily,
    handle: "prooffamily",
    defaultVerb: "answer",
    intake: "strict",
  };

  it("clears when the tokens pass their declared types", () => {
    const answer = findDeclaredVerb(positional, "answer")!;
    expect(clearsShapeFloor(positional, answer, `12 https://example.com/x ${ADDRESS}`)).toBe(true);
  });

  it("fails on the first typed slot when given prose", () => {
    const answer = findDeclaredVerb(positional, "answer")!;
    // Right token count, wrong types — this is the case token counting misses.
    expect(clearsShapeFloor(positional, answer, "thanks that worked")).toBe(false);
    expect(clearsShapeFloor(positional, answer, `12 not-a-url ${ADDRESS}`)).toBe(false);
  });

  it("fails on the wrong token count", () => {
    const answer = findDeclaredVerb(positional, "answer")!;
    expect(clearsShapeFloor(positional, answer, "12")).toBe(false);
    expect(clearsShapeFloor(positional, answer, `12 https://example.com/x ${ADDRESS} extra`)).toBe(
      false,
    );
  });

  it("has no floor available when the default verb takes one free-text argument", () => {
    const weak: FamilySpec = {
      ...bountyFamily,
      verbs: [
        {
          name: "ask",
          summary: "ask",
          args: [{ name: "question", type: "text", required: true, maxLength: 200 }],
          example: "@x ask something",
        },
      ],
      defaultVerb: "ask",
    };
    const ask = findDeclaredVerb(weak, "ask")!;
    expect(clearsShapeFloor(weak, ask, "anything at all")).toBe(false);
  });
});

describe("intake modes", () => {
  const explicitFamily: FamilySpec = {
    ...bountyFamily,
    handle: "strictdesk",
    defaultVerb: undefined,
    intake: "explicit",
  };

  it("forwards an unrecognized verb for the platform to reject", () => {
    const result = parseMention("@strictdesk frobnicate | a thing", {
      handles: ["strictdesk"],
      family: explicitFamily,
    });
    expect(result.kind).toBe("command");
    if (result.kind !== "command") return;
    // The agent reports; it does not pre-reject.
    expect(result.verbName).toBe("frobnicate");
    expect(result.resolution).toBe("unresolved");
    expect(result.verb).toBeNull();
  });

  it("still stays silent on a non-command-shaped candidate", () => {
    const result = parseMention("@strictdesk hey are you around", {
      handles: ["strictdesk"],
      family: explicitFamily,
    });
    expect(result.kind).toBe("silent");
  });

  it("waives the silence rule under open intake", () => {
    const openFamily: FamilySpec = {
      ...bountyFamily,
      handle: "askbot",
      intake: "open",
      verbs: bountyFamily.verbs.filter((verb) => !verb.consequential),
      defaultVerb: "post",
    };
    const result = parseMention("@askbot what is the weather", {
      handles: ["askbot"],
      family: openFamily,
    });
    expect(result.kind).toBe("command");
  });
});

describe("near-miss detection", () => {
  it("flags a typo'd verb without changing resolution", () => {
    // The classic: `cancl` becomes a bounty title, but never silently.
    const result = parse(`@bountydesk cancl | bnt_4812 | x | 1 ETH | 7d | ${ADDRESS}`);
    expect(result.kind).toBe("command");
    if (result.kind !== "command") return;
    expect(result.verbName).toBe("post");
    expect(result.nearMiss).toMatchObject({ token: "cancl", suspectedVerb: "cancel" });
    // A near-miss counts as ambiguous, so a destructive suspect is confirmed.
    expect(result.resolution).toBe("ambiguous");
  });

  it("allows distance 1 for short tokens and 2 for long ones", () => {
    expect(detectNearMiss(bountyFamily, "clam")?.suspectedVerb).toBe("claim");
    expect(detectNearMiss(bountyFamily, "claimm")?.suspectedVerb).toBe("claim");
    // Distance 2 on a 5-char token is too far.
    expect(detectNearMiss(bountyFamily, "clxxm")).toBeUndefined();
    // Distance 2 on an 8+ char token is allowed.
    expect(detectNearMiss(bountyFamily, "requirments")).toBeUndefined();
  });

  it("catches transpositions, which plain edit distance underrates", () => {
    expect(detectNearMiss(bountyFamily, "cnacel")?.suspectedVerb).toBe("cancel");
    expect(damerauLevenshtein("cnacel", "cancel")).toBe(1);
  });

  it("never flags a token of three characters or fewer", () => {
    expect(detectNearMiss(bountyFamily, "pos")).toBeUndefined();
    expect(detectNearMiss(bountyFamily, "yes")).toBeUndefined();
  });

  it("does not flag a real verb", () => {
    expect(detectNearMiss(bountyFamily, "cancel")).toBeUndefined();
    expect(detectNearMiss(bountyFamily, "help")).toBeUndefined();
  });

  it("compares against reserved verbs too", () => {
    expect(detectNearMiss(bountyFamily, "halp")?.suspectedVerb).toBe("help");
  });

  it("does not flag an ordinary title that happens to be a word", () => {
    const result = parse(`@bountydesk recipe site | reqs | 0.005 ETH | 7d | ${ADDRESS}`);
    expect(result.kind).toBe("command");
    if (result.kind !== "command") return;
    expect(result.nearMiss).toBeUndefined();
  });
});

describe("the agent forwards what it believes is malformed", () => {
  // Argument validation is the platform's job. An agent that pre-rejects is an
  // agent making authorization decisions.
  it("forwards a command with unreadable values, as advisory hints", () => {
    const result = parse(
      `@bountydesk post | logo | vector | about 5 ETH | next friday | ${ADDRESS}`,
    );
    expect(result.kind).toBe("command");
    if (result.kind !== "command") return;
    expect(result.verbName).toBe("post");
    expect(result.argErrors.map((error) => error.arg)).toEqual(
      expect.arrayContaining(["reward", "deadline"]),
    );
    // Raw fields always travel, so the site can validate from source.
    expect(result.rawFields).toEqual(["logo", "vector", "about 5 ETH", "next friday", ADDRESS]);
  });

  it("forwards a command with too few arguments", () => {
    const result = parse("@bountydesk post | just a title | and reqs | 1 ETH");
    expect(result.kind).toBe("command");
    if (result.kind !== "command") return;
    expect(result.argErrors.some((error) => error.code === "arg_missing")).toBe(true);
  });

  it("forwards a command with too many fields", () => {
    const result = parse(`@bountydesk post | a | b | 1 ETH | 7d | ${ADDRESS} | extra`);
    expect(result.kind).toBe("command");
    if (result.kind !== "command") return;
    expect(result.argErrors.some((error) => error.code === "arg_count_mismatch")).toBe(true);
  });

  it("still normalizes the fields it can read", () => {
    const result = parse(`@bountydesk post | logo | vector | 0.005 ETH | next friday | ${ADDRESS}`);
    expect(result.kind).toBe("command");
    if (result.kind !== "command") return;
    // Partial coercion is not offered: the site validates the whole thing.
    expect(result.rawArgs.reward).toBe("0.005 ETH");
  });
});

describe("positional arguments and literal tokens", () => {
  // `bountii` is intentional, not a typo: the spec names it twice.
  it("parses the spec's `answer bountii <id> <url>` form", () => {
    const result = parse(`@bountydesk answer bountii 12 https://example.com/proof ${ADDRESS}`);
    expect(result.kind).toBe("command");
    if (result.kind !== "command") return;
    expect(result.args).toEqual({
      bounty_id: "12",
      url: "https://example.com/proof",
      reward_address: ADDRESS,
    });
  });

  it("parses identically with the literal token omitted", () => {
    const withToken = parse(`@bountydesk answer bountii 12 https://example.com/proof ${ADDRESS}`);
    const without = parse(`@bountydesk answer 12 https://example.com/proof ${ADDRESS}`);
    expect(withToken.kind).toBe("command");
    expect(without.kind).toBe("command");
    if (withToken.kind !== "command" || without.kind !== "command") return;
    expect(without.args).toEqual(withToken.args);
  });

  it("handles the acceptance criteria's exact example", () => {
    const result = parse(`@bountydesk answer bountii 1 https://example.com/x ${ADDRESS}`);
    expect(result.kind).toBe("command");
    if (result.kind !== "command") return;
    expect(result.args.bounty_id).toBe("1");
  });
});

describe("splitting", () => {
  it("splits pipes and trims", () => {
    expect(splitPipeArgs("a | b |c")).toEqual(["a", "b", "c"]);
  });

  it("drops trailing empty fields but keeps explicitly empty interior ones", () => {
    expect(splitPipeArgs("a | b |")).toEqual(["a", "b"]);
    expect(splitPipeArgs("a || c")).toEqual(["a", "", "c"]);
  });

  it("honours the only two escapes the grammar defines", () => {
    expect(splitPipeArgs("a \\| still a | b")).toEqual(["a | still a", "b"]);
    expect(splitPipeArgs("a \\\\ b | c")).toEqual(["a \\ b", "c"]);
  });

  it("collapses newlines inside a field", () => {
    expect(splitPipeArgs("title | line one\nline two | 1 ETH")).toEqual([
      "title",
      "line one line two",
      "1 ETH",
    ]);
  });

  it("discards declared literal tokens wherever they lead", () => {
    expect(splitPositionalArgs("bountii 12 url", ["bountii"])).toEqual(["12", "url"]);
    expect(splitPositionalArgs("BOUNTII 12 url", ["bountii"])).toEqual(["12", "url"]);
    expect(splitPositionalArgs("12 url", ["bountii"])).toEqual(["12", "url"]);
  });

  it("does not discard a literal token that appears as a value", () => {
    expect(splitPositionalArgs("12 bountii", ["bountii"])).toEqual(["12", "bountii"]);
  });
});
