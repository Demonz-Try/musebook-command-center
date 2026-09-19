import { describe, expect, it } from "vitest";
import { intakeOf, type FamilySpec, type VerbSpec } from "../src/command/registry.js";
import { validateFamily } from "../src/families/index.js";
import { bountyFamily } from "../src/families/bounty.js";

function family(overrides: Partial<FamilySpec>): FamilySpec {
  return { ...bountyFamily, ...overrides };
}

function verb(overrides: Partial<VerbSpec> & { name: string }): VerbSpec {
  return { summary: "x", args: [], example: "@x y", ...overrides };
}

describe("intake defaults", () => {
  it("defaults to strict when a default verb is declared", () => {
    expect(intakeOf({ ...bountyFamily, intake: undefined })).toBe("strict");
  });

  it("defaults to explicit when there is no default verb", () => {
    expect(intakeOf({ ...bountyFamily, intake: undefined, defaultVerb: undefined })).toBe("explicit");
  });

  it("accepts the bounty family as declared", () => {
    expect(() => validateFamily(bountyFamily)).not.toThrow();
    expect(intakeOf(bountyFamily)).toBe("strict");
  });
});

describe("manifest validation", () => {
  it("rejects explicit intake combined with a default verb", () => {
    expect(() => validateFamily(family({ intake: "explicit" }))).toThrow(/cannot be combined/);
  });

  // Past a certain size the verb table stops being memorable and a default
  // verb turns every mistyped verb into a new subject.
  it("requires explicit intake above eight verbs", () => {
    const many = family({
      verbs: [
        ...bountyFamily.verbs,
        verb({ name: "extra1" }),
        verb({ name: "extra2" }),
        verb({ name: "extra3" }),
      ],
    });
    expect(many.verbs.length).toBeGreaterThan(8);
    expect(() => validateFamily(many)).toThrow(/must use intake "explicit"/);
  });

  // The constraint that binds is not the size of the verb set — it is whether
  // the default verb's arguments are shaped enough to tell a command from a
  // greeting.
  it("rejects strict intake when the default verb takes a single free-text argument", () => {
    const weak = family({
      verbs: [
        verb({
          name: "ask",
          args: [{ name: "question", type: "text", required: true, maxLength: 200 }],
        }),
      ],
      defaultVerb: "ask",
      intake: "strict",
    });
    expect(() => validateFamily(weak)).toThrow(/at least two required arguments/);
  });

  it("names the alternatives when it rejects that combination", () => {
    const weak = family({
      verbs: [verb({ name: "ask", args: [{ name: "q", type: "text", required: true }] })],
      defaultVerb: "ask",
      intake: "strict",
    });
    expect(() => validateFamily(weak)).toThrow(/"explicit".*"open"/s);
  });

  // An open-intake family cannot distinguish an instruction from a remark, so
  // it must not be able to move anything.
  it("forbids open intake for a family with destructive verbs", () => {
    expect(() => validateFamily(family({ intake: "open" }))).toThrow(/forbidden for destructive/);
  });

  it("allows open intake for a read-only family", () => {
    const readOnly = family({
      intake: "open",
      verbs: bountyFamily.verbs.filter((candidate) => !candidate.consequential),
    });
    expect(() => validateFamily(readOnly)).not.toThrow();
  });

  it("rejects strict intake with no default verb", () => {
    expect(() => validateFamily(family({ intake: "strict", defaultVerb: undefined }))).toThrow(
      /needs a default_verb/,
    );
  });

  it("still enforces the single-word handle", () => {
    expect(() => validateFamily(family({ handle: "bounty desk" }))).toThrow(/whitespace/);
  });

  it("still rejects a positional verb with a free-text argument", () => {
    const bad = family({
      verbs: [
        verb({
          name: "note",
          argStyle: "positional",
          args: [{ name: "body", type: "text", required: true, maxLength: 200 }],
        }),
        ...bountyFamily.verbs,
      ],
      intake: "explicit",
      defaultVerb: undefined,
    });
    expect(() => validateFamily(bad)).toThrow(/positional arguments cannot contain spaces/);
  });
});
