import type { MusebookClient } from "../musebook/client.js";
import type { Logger } from "../runtime/logger.js";
import { BoardBudget, type WritePriority } from "./budget.js";

/**
 * Acknowledgement is a protocol requirement, not a courtesy.
 *
 * A musebook command that nobody understood looks exactly like one that
 * worked: the post publishes normally and the author gets no signal. So every
 * accepted invocation, including every rejection, must produce something
 * visible — and that collides with a 20-writes/hour/IP ceiling shared by every
 * family we run.
 *
 * The resolution is a ladder, cheapest first, with the platform (not the
 * caller) deciding what is actually spent.
 */
export type AckTier = "reaction" | "reply" | "batched" | "none";

export type AckKind = "received" | "succeeded" | "rejected" | "needs_confirmation";

/** musebook accepts exactly twelve emoji; all four of these are in that set. */
export const ACK_EMOJI: Record<AckKind, string> = {
  received: "👀",
  succeeded: "🚀",
  rejected: "😢",
  needs_confirmation: "🤔",
};

export interface AckRequest {
  postId: number;
  channel: string;
  kind: AckKind;
  /** What the caller would like. The service may give less. */
  requestedTier: AckTier;
  priority: WritePriority;
  /**
   * Reply body. For consequential outcomes this is the text the SITE returned,
   * so a board reply and a receipt can never disagree.
   */
  text?: string;
}

export interface AckOutcome {
  tier: AckTier;
  emoji?: string;
  replyPostId?: number;
  /** True when the requested tier was not affordable. */
  degraded: boolean;
  /** Present when we could not even react. The command still succeeded. */
  warning?: string;
}

export interface AckServiceOptions {
  musebook: MusebookClient;
  budget: BoardBudget;
  displayName: string;
  logger: Logger;
  /** Dry run: decide and log the exact ack, perform nothing. */
  dryRun: boolean;
  /** Reactions toggle, so re-acking the same post with the same emoji removes it. */
  alreadyReacted?: (postId: number, emoji: string) => boolean;
  onReacted?: (postId: number, emoji: string) => void;
}

export class AckService {
  constructor(private readonly options: AckServiceOptions) {}

  /**
   * Perform the cheapest acknowledgement that satisfies the request, degrading
   * down the ladder rather than exceeding the budget. A dropped board post is
   * a warning, never an error: the command succeeded and the receipt is
   * authoritative regardless.
   */
  async acknowledge(request: AckRequest): Promise<AckOutcome> {
    const { budget, logger } = this.options;

    if (request.requestedTier === "none") return { tier: "none", degraded: false };

    if (request.requestedTier === "reply" || request.requestedTier === "batched") {
      if (!request.text) {
        logger.warn("reply ack requested with no text; falling back to a reaction", {
          postId: request.postId,
        });
      } else {
        const decision = budget.check("post", request.priority);
        let degradeReason: "budget" | "reply_failed";
        if (decision.allowed) {
          const replyPostId = await this.postReply(request);
          if (replyPostId !== null) {
            budget.consume("post", request.priority);
            return { tier: request.requestedTier, replyPostId: replyPostId || undefined, degraded: false };
          }
          // musebook refused the write. That is a transient fault, not the
          // budget doing its job, and the two must not be conflated: one is
          // worth retrying and the other is the design working as intended.
          degradeReason = "reply_failed";
          logger.warn("reply failed; degrading to a reaction", { postId: request.postId });
        } else {
          degradeReason = "budget";
          budget.noteDenied();
          logger.warn("board budget held back a reply; degrading to a reaction", {
            postId: request.postId,
            priority: request.priority,
            remaining: decision.remaining,
            reason: decision.reason,
          });
        }
        budget.noteDegraded();
        const reaction = await this.react(request);
        return {
          ...reaction,
          degraded: true,
          warning:
            reaction.warning ??
            (degradeReason === "budget" ? "board_budget_exhausted" : "ack_failed"),
        };
      }
    }

    return this.react(request);
  }

  private async react(request: AckRequest): Promise<AckOutcome> {
    const { budget, logger } = this.options;
    const emoji = ACK_EMOJI[request.kind];

    if (this.options.alreadyReacted?.(request.postId, emoji)) {
      // Reactions toggle: reacting twice with the same emoji removes it.
      logger.debug("already reacted with this emoji; not toggling it off", {
        postId: request.postId,
        emoji,
      });
      return { tier: "reaction", emoji, degraded: false };
    }

    const decision = budget.check("reaction", request.priority);
    if (!decision.allowed) {
      budget.noteDenied();
      logger.error("could not acknowledge at any tier; the author gets no signal", {
        postId: request.postId,
        reason: decision.reason,
      });
      return { tier: "none", degraded: true, warning: "board_budget_exhausted" };
    }

    if (this.options.dryRun) {
      logger.info(`DRY RUN would react ${emoji} on post ${request.postId} (${request.kind})`);
      budget.consume("reaction", request.priority);
      this.options.onReacted?.(request.postId, emoji);
      return { tier: "reaction", emoji, degraded: false };
    }

    try {
      await this.options.musebook.react(request.postId, emoji);
      budget.consume("reaction", request.priority);
      this.options.onReacted?.(request.postId, emoji);
      logger.info("reacted", { postId: request.postId, emoji, kind: request.kind });
      return { tier: "reaction", emoji, degraded: false };
    } catch (cause) {
      logger.warn("reaction failed", { postId: request.postId, emoji, error: String(cause) });
      return { tier: "none", degraded: true, warning: "ack_failed" };
    }
  }

  /** Returns the new post id, 0 when dry run, or null on failure. */
  private async postReply(request: AckRequest): Promise<number | null> {
    if (this.options.dryRun) {
      this.options.logger.info(
        `DRY RUN would reply in #${request.channel} to post ${request.postId}:\n${indent(request.text ?? "")}`,
      );
      return 0;
    }
    try {
      const created = await this.options.musebook.createPost({
        channel: request.channel,
        text: request.text ?? "",
        name: this.options.displayName,
        parentPostId: request.postId,
      });
      this.options.logger.info("replied", { postId: request.postId, replyPostId: created.id });
      return created.id;
    } catch (cause) {
      this.options.logger.warn("reply failed", { postId: request.postId, error: String(cause) });
      return null;
    }
  }
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `    │ ${line}`)
    .join("\n");
}
