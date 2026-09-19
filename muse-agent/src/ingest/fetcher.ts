import type { MusebookClient } from "../musebook/client.js";
import { PermanentPostError, type MusebookPost } from "../musebook/types.js";
import type { Logger } from "../runtime/logger.js";

/**
 * Resolves full post bodies by id.
 *
 * This exists because the mention inbox only carries the first 200 characters
 * of a post. That is a notification, not a payload — any command longer than a
 * sentence is truncated mid-argument — so every mention requires a second fetch
 * before parsing. Nothing downstream is ever handed an excerpt.
 */
export type FetchOutcome =
  | { ok: true; post: MusebookPost }
  | { ok: false; reason: "unavailable" | "not_found"; detail?: string };

export interface PostFetcherOptions {
  client: MusebookClient;
  logger?: Logger;
  /** How long a channel feed page stays reusable. */
  feedCacheTtlMs?: number;
  /** Ids known to 500 forever. Shared with the durable state. */
  isPoisoned?: (postId: number) => boolean;
  onPoisoned?: (postId: number) => void;
  now?: () => number;
}

export class PostFetcher {
  private readonly client: MusebookClient;
  private readonly logger?: Logger;
  private readonly feedCacheTtlMs: number;
  private readonly isPoisoned: (postId: number) => boolean;
  private readonly onPoisoned?: (postId: number) => void;
  private readonly now: () => number;
  private readonly posts = new Map<number, MusebookPost>();
  private readonly feedFetchedAt = new Map<string, number>();

  constructor(options: PostFetcherOptions) {
    this.client = options.client;
    this.logger = options.logger;
    this.feedCacheTtlMs = options.feedCacheTtlMs ?? 20_000;
    this.isPoisoned = options.isPoisoned ?? (() => false);
    this.onPoisoned = options.onPoisoned;
    this.now = options.now ?? Date.now;
  }

  /** Index posts we already have in hand, e.g. from a poll or a thread walk. */
  prime(posts: readonly MusebookPost[]): void {
    for (const post of posts) this.posts.set(post.id, post);
  }

  peek(postId: number): MusebookPost | undefined {
    return this.posts.get(postId);
  }

  /**
   * Fetch one post. Tries the cheap paths first — memory, then the channel feed
   * (one request covers up to 100 posts) — and only then thread.json, which is
   * the endpoint with the permanent 500s.
   */
  async getPost(postId: number, channelHint?: string | null): Promise<FetchOutcome> {
    const cached = this.posts.get(postId);
    if (cached) return { ok: true, post: cached };

    if (this.isPoisoned(postId)) {
      return { ok: false, reason: "unavailable", detail: "post id previously returned a permanent 500" };
    }

    if (channelHint && this.shouldRefreshFeed(channelHint)) {
      try {
        const posts = await this.client.getLatest(channelHint, 100);
        this.prime(posts);
        this.feedFetchedAt.set(channelHint, this.now());
        const found = this.posts.get(postId);
        if (found) return { ok: true, post: found };
      } catch (cause) {
        this.logger?.warn("feed lookup failed, falling back to thread", {
          channel: channelHint,
          error: String(cause),
        });
      }
    }

    try {
      const thread = await this.client.getThread(postId);
      this.prime(thread);
      const found = this.posts.get(postId);
      if (found) return { ok: true, post: found };
      // The thread resolved but did not contain the id we asked for. Nothing
      // more to try: there is no other endpoint that serves a post by id.
      return { ok: false, reason: "not_found" };
    } catch (cause) {
      if (cause instanceof PermanentPostError) {
        this.logger?.warn("thread.json is permanently broken for this post; skipping", {
          postId,
          status: cause.status,
        });
        this.onPoisoned?.(postId);
        return { ok: false, reason: "unavailable", detail: cause.message };
      }
      throw cause;
    }
  }

  /**
   * Fetch a whole thread by id, used by backfill: one request accounts for
   * every id in the thread, not just the one asked for.
   */
  async getThreadPosts(postId: number): Promise<{ ok: true; posts: MusebookPost[] } | { ok: false }> {
    if (this.isPoisoned(postId)) return { ok: false };
    try {
      const posts = await this.client.getThread(postId);
      this.prime(posts);
      return { ok: true, posts };
    } catch (cause) {
      if (cause instanceof PermanentPostError) {
        this.onPoisoned?.(postId);
        return { ok: false };
      }
      throw cause;
    }
  }

  private shouldRefreshFeed(channel: string): boolean {
    const last = this.feedFetchedAt.get(channel);
    return last === undefined || this.now() - last > this.feedCacheTtlMs;
  }
}
