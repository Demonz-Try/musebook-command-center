import { readFile } from "node:fs/promises";
import {
  findDeclaredVerb,
  intakeOf,
  requiredArity,
  type FamilySpec,
} from "../command/registry.js";
import { bountyFamily } from "./bounty.js";

/** Families shipped in-tree. Adding one is adding a file here. */
export const BUILT_IN_FAMILIES: Record<string, FamilySpec> = {
  [bountyFamily.id]: bountyFamily,
};

export class UnknownFamilyError extends Error {
  constructor(id: string) {
    super(`unknown command family "${id}" — known: ${Object.keys(BUILT_IN_FAMILIES).join(", ")}`);
  }
}

/**
 * Resolve a family by id, or load one from a JSON file so an operator can run a
 * family that does not live in this repo.
 */
export async function loadFamily(idOrPath: string): Promise<FamilySpec> {
  if (BUILT_IN_FAMILIES[idOrPath]) return BUILT_IN_FAMILIES[idOrPath]!;
  if (/\.json$/i.test(idOrPath)) {
    const contents = await readFile(idOrPath, "utf8");
    return validateFamily(JSON.parse(contents) as unknown);
  }
  throw new UnknownFamilyError(idOrPath);
}

export function validateFamily(raw: unknown): FamilySpec {
  if (typeof raw !== "object" || raw === null) throw new Error("family config must be an object");
  const family = raw as FamilySpec;
  const problems: string[] = [];
  if (!family.id) problems.push("id is required");
  if (!family.handle) problems.push("handle is required");
  if (family.handle && /\s/.test(family.handle)) {
    problems.push(`handle "${family.handle}" contains whitespace; musebook cannot mention multi-word names`);
  }
  if (family.handle && !/^[\p{L}\p{N}_-]+$/u.test(family.handle)) {
    problems.push(`handle "${family.handle}" contains punctuation musebook's mention matcher will not match`);
  }
  if (!Array.isArray(family.verbs) || family.verbs.length === 0) {
    problems.push("at least one verb is required");
  }
  const seen = new Set<string>();
  for (const verb of family.verbs ?? []) {
    for (const name of [verb.name, ...(verb.aliases ?? [])]) {
      const key = name.toLowerCase();
      if (seen.has(key)) problems.push(`duplicate verb name or alias "${name}"`);
      seen.add(key);
    }
  }
  if (family.defaultVerb && !seen.has(family.defaultVerb.toLowerCase())) {
    problems.push(`default_verb "${family.defaultVerb}" is not a declared verb`);
  }
  problems.push(...intakeProblems(family));
  for (const verb of family.verbs ?? []) {
    const style = verb.argStyle ?? family.argStyle ?? "pipe";
    if (style !== "positional") continue;
    // A positional argument cannot contain whitespace, so anything sized for
    // prose is a design error — and it is cheaper to catch here than to
    // discover as an arity mismatch on a live board.
    for (const arg of verb.args) {
      if (arg.type === "text" && (arg.maxLength ?? 280) > 64) {
        problems.push(
          `verb "${verb.name}" is positional but declares "${arg.name}" as free text up to ` +
            `${arg.maxLength ?? 280} chars; positional arguments cannot contain spaces. Use arg_style "pipe".`,
        );
      }
    }
    if (verb.literalTokens?.some((token) => /\s/.test(token))) {
      problems.push(`verb "${verb.name}" declares a literal token containing whitespace`);
    }
  }
  if (problems.length) throw new Error(`invalid family config:\n  - ${problems.join("\n  - ")}`);
  return family;
}

/**
 * Intake is the manifest's disambiguation knob, and the constraints on it are
 * what stop a family from being unable to tell a command from a greeting.
 */
function intakeProblems(family: FamilySpec): string[] {
  const problems: string[] = [];
  const intake = intakeOf(family);
  const verbCount = family.verbs?.length ?? 0;

  if (intake === "explicit" && family.defaultVerb) {
    problems.push('intake "explicit" cannot be combined with a default_verb: the verb is always required');
  }

  // Past a certain size the verb table stops being memorable and a default
  // verb makes every mistyped verb a new subject.
  if (verbCount > 8 && intake !== "explicit") {
    problems.push(
      `a family with ${verbCount} verbs must use intake "explicit" (got "${intake}")`,
    );
  }

  if (intake === "strict") {
    if (!family.defaultVerb) {
      problems.push('intake "strict" needs a default_verb; use "explicit" if there is no default');
    } else {
      const fallback = findDeclaredVerb(family, family.defaultVerb);
      if (fallback && requiredArity(fallback) < 2) {
        // Every candidate clears a one-argument floor trivially, so "strict"
        // would silently mean "open" — and open is forbidden for anything
        // that moves value.
        problems.push(
          `intake "strict" needs the default verb "${fallback.name}" to take at least two required ` +
            "arguments, or there is no shape floor to tell a command from a greeting. " +
            'Use intake "explicit", or "open" if the family is read-only.',
        );
      }
    }
  }

  if (intake === "open") {
    const destructive = (family.verbs ?? []).filter((verb) => verb.consequential);
    if (destructive.length > 0) {
      // An open-intake family cannot distinguish an instruction from a remark,
      // so it must not be able to move anything.
      problems.push(
        `intake "open" waives the silence rule and is forbidden for destructive or value-moving verbs: ` +
          destructive.map((verb) => verb.name).join(", "),
      );
    }
  }

  return problems;
}

export { bountyFamily };
