import type { MusebookPost } from "../musebook/types.js";
import type { Logger } from "../runtime/logger.js";
import type { PostFetcher } from "./fetcher.js";
import { closeGapId, markPoisoned, recordPost, type AgentState } from "./state.js";

/**
 * Gap recovery.
 *
 * Once a post scrolls past the 100-post window it cannot be listed by any
 * endpoint — there is no cursor, no since_id, no archive, and the feed gives no
 * signal that a gap exists. The only way back is to probe ids one at a time
 * through thread.json, which is also the endpoint with reproducible permanent
 * 500s. So this loop is built around skipping poisoned ids rather than
 * retrying them: one poisoned id retried forever wedges the agent permanently.
 */
export interface BackfillOptions {
  /** Max thread.json requests per pass, so a large gap never becomes a burst. */
  budget?: number;
  /** Decides which recovered posts are worth queueing. */
  isInteresting: (post: MusebookPost) => boolean;
  logger?: Logger;
}

export interface BackfillResult {
  requested: number;
  recovered: number;
  queued: number;
  skipped: number;
  remaining: number;
  complete: boolean;
}

export async function runBackfill(
  state: AgentState,
  fetcher: PostFetcher,
  options: BackfillOptions,
): Promise<BackfillResult> {
  const budget = options.budget ?? 50;
  const result: BackfillResult = {
    requested: 0,
    recovered: 0,
    queued: 0,
    skipped: 0,
    remaining: state.gap?.remaining.length ?? 0,
    complete: !state.gap,
  };
  if (!state.gap) return result;

  options.logger?.info("backfilling gap", {
    from: state.gap.from,
    to: state.gap.to,
    remaining: state.gap.remaining.length,
  });

  while (state.gap && state.gap.remaining.length > 0 && result.requested < budget) {
    // Work newest-first: the most recent missed commands are the ones still
    // worth acting on if the gap turns out to be too large to finish.
    const postId = state.gap.remaining[state.gap.remaining.length - 1]!;
    result.requested += 1;

    const outcome = await fetcher.getThreadPosts(postId);

    if (!outcome.ok) {
      markPoisoned(state, postId);
      result.skipped += 1;
      options.logger?.warn("skipping permanently broken post id", { postId });
      continue;
    }

    // One thread covers many ids. Account for all of them before spending
    // another request, which is what makes a large gap affordable.
    for (const post of outcome.posts) {
      result.recovered += 1;
      closeGapId(state, post.id);
      if (options.isInteresting(post)) {
        const record = recordPost(state, {
          postId: post.id,
          source: "backfill",
          channel: post.channel,
          fromMuseId: post.muse_id,
        });
        if (record && record.status === "seen" && record.source === "backfill") result.queued += 1;
      }
    }

    // Always account for the probed id itself, even when the thread came back
    // without it, or the loop would ask for it again forever.
    closeGapId(state, postId);
  }

  result.remaining = state.gap?.remaining.length ?? 0;
  result.complete = !state.gap;
  options.logger?.info("backfill pass finished", { ...result });
  return result;
}
