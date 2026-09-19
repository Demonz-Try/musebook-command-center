import { PlatformError, type PlatformErrorCode } from "../errors";
import { NotCommandShaped } from "./shape";
import type { DispatchOutcome } from "./registry";

/**
 * A reply for every invocation, including the ones we refused.
 *
 * Musebook gives a command author no feedback of its own: a post that we ignore
 * looks identical to a post we never saw, and identical again to one we
 * rejected. Silence is therefore not an option — a rejected command has to come
 * back with a code the author can act on, or the failure mode is a muse
 * re-posting the same broken amount forever.
 */
export interface Acknowledgement {
  object: "acknowledgement";
  ok: boolean;
  /** `null` when the command never resolved to a family. */
  command: string | null;
  family: string | null;
  /** The line a client posts back verbatim. */
  message: string;
  code: PlatformErrorCode | null;
  data: unknown;
}

export function acknowledgeSuccess(outcome: DispatchOutcome): Acknowledgement {
  return {
    object: "acknowledgement",
    ok: true,
    command: outcome.command,
    family: outcome.family,
    message: outcome.message,
    code: null,
    data: outcome.data ?? null,
  };
}

export function acknowledgeFailure(error: unknown): Acknowledgement {
  const platform = error instanceof PlatformError ? error : null;
  const code: PlatformErrorCode = platform?.code ?? "validation";
  const detail = platform
    ? platform.message
    : "something broke on our side while running that command";
  return {
    object: "acknowledgement",
    ok: false,
    command: null,
    family: null,
    message: `Rejected (${code}): ${detail}`,
    code,
    data: null,
  };
}

/**
 * Runs a dispatch and resolves to something postable — unless the input was
 * never a command.
 *
 * `NotCommandShaped` is rethrown rather than turned into a rejection reply.
 * Every other failure owes the author an answer; this one owes them silence,
 * and the whole point of the silence rule is lost if the thing that guarantees
 * a reply also replies to conversation.
 */
export async function acknowledging(
  run: () => Promise<DispatchOutcome>,
): Promise<Acknowledgement> {
  try {
    return acknowledgeSuccess(await run());
  } catch (error) {
    if (error instanceof NotCommandShaped) throw error;
    return acknowledgeFailure(error);
  }
}
