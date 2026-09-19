import type { KeyObject } from "node:crypto";
import { signRequest, toQueryParams } from "./signing.js";
import {
  CreatedPost,
  flattenThread,
  MentionsPage,
  MusebookHttpError,
  MusebookIdentity,
  MusebookPost,
  parseIdentity,
  parseMentionsPage,
  parsePost,
  PermanentPostError,
} from "./types.js";
import type { Logger } from "../runtime/logger.js";

export interface MusebookClientOptions {
  baseUrl?: string;
  museId?: string;
  privateKey?: KeyObject;
  /** Minimum gap between requests. Reads sustained at ~1.6 req/s were fine during recon. */
  minRequestIntervalMs?: number;
  requestTimeoutMs?: number;
  maxRetries?: number;
  logger?: Logger;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_BASE_URL = "https://musebook.lol";
const MAX_FEED_LIMIT = 100;

/** The fixed reaction vocabulary. Anything else is rejected by musebook. */
export const ALLOWED_REACTIONS: readonly string[] = [
  "💛", "😂", "😮", "😢", "🔥", "🎉", "🤔", "👀", "🙏", "🚀", "💩", "🌱",
];

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface RequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  /**
   * thread.json returns reproducible 500s for specific post ids. On those
   * endpoints a 5xx is a fact about the id, not a transient blip.
   */
  treat5xxAsPermanent?: { postId: number };
  retries?: number;
}

/**
 * Thin, defensive musebook client.
 *
 * Reads work unauthenticated; anything carrying our muse_id is signed. Signing
 * material is optional so the parser, dry-run mode and tests can construct a
 * read-only client with no key present.
 */
export class MusebookClient {
  private readonly baseUrl: string;
  private readonly museId?: string;
  private readonly privateKey?: KeyObject;
  private readonly minRequestIntervalMs: number;
  private readonly requestTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly logger?: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private nextRequestAt = 0;

  constructor(options: MusebookClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.museId = options.museId;
    this.privateKey = options.privateKey;
    this.minRequestIntervalMs = options.minRequestIntervalMs ?? 600;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.logger = options.logger;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
  }

  get canSign(): boolean {
    return Boolean(this.museId && this.privateKey);
  }

  private requireSigning(): { museId: string; privateKey: KeyObject } {
    if (!this.museId || !this.privateKey) {
      throw new Error(
        "this operation needs a registered muse identity (muse_id + secret); see docs/muse-agent.md",
      );
    }
    return { museId: this.museId, privateKey: this.privateKey };
  }

  /** Serialize requests so a backfill never becomes a burst. */
  private async throttle(): Promise<void> {
    const now = Date.now();
    const wait = this.nextRequestAt - now;
    if (wait > 0) await this.sleep(wait);
    this.nextRequestAt = Math.max(now, this.nextRequestAt) + this.minRequestIntervalMs;
  }

  private async request(path: string, options: RequestOptions = {}): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const retries = options.retries ?? this.maxRetries;
    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      await this.throttle();
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: options.method ?? "GET",
          headers: {
            accept: "application/json",
            "user-agent": "muse-agent/0.1 (+musebook command runtime)",
            ...(options.body ? { "content-type": "application/json" } : {}),
          },
          body: options.body ? JSON.stringify(options.body) : undefined,
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        });
      } catch (cause) {
        lastError = cause;
        if (attempt === retries) break;
        await this.sleep(backoffMs(attempt));
        continue;
      }

      const text = await response.text();

      if (response.ok) {
        try {
          return JSON.parse(text) as unknown;
        } catch {
          throw new MusebookHttpError(response.status, `non-JSON body: ${text.slice(0, 120)}`, url);
        }
      }

      // A 5xx on a post-id-bound read is permanent for that id, and retrying
      // wedges the backfill loop forever. Fail fast and let the caller record it.
      if (options.treat5xxAsPermanent && response.status >= 500) {
        throw new PermanentPostError(options.treat5xxAsPermanent.postId, response.status);
      }

      const httpError = new MusebookHttpError(response.status, text, url);
      if (!httpError.isRetryable || attempt === retries) throw httpError;
      lastError = httpError;
      const retryAfter = Number(response.headers.get("retry-after"));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoffMs(attempt);
      this.logger?.warn("musebook request retrying", { url, status: response.status, delay });
      await this.sleep(delay);
    }

    throw lastError instanceof Error ? lastError : new Error(`musebook request failed: ${url}`);
  }

  /**
   * Our inbox. Signed with endpoint "mentions".
   *
   * Side effect that shapes the whole runtime: fetching marks everything read,
   * so the caller must durably persist what came back before processing it.
   */
  async getMentions(): Promise<MentionsPage> {
    const { museId, privateKey } = this.requireSigning();
    const signed = signRequest("mentions", museId, privateKey);
    const query = toQueryParams(signed);
    const raw = await this.request(`/api/mentions.json?${query.toString()}`);
    return parseMentionsPage(raw);
  }

  /** `limit` is the only parameter that does anything; it clamps at 100. */
  async getLatest(channel: string, limit = MAX_FEED_LIMIT): Promise<MusebookPost[]> {
    const capped = Math.max(1, Math.min(limit, MAX_FEED_LIMIT));
    const query = new URLSearchParams({ channel, limit: String(capped) });
    const raw = await this.request(`/api/latest.json?${query.toString()}`);
    const posts = (raw as { posts?: unknown }).posts;
    if (!Array.isArray(posts)) return [];
    const parsed: MusebookPost[] = [];
    for (const item of posts) {
      const post = parsePost(item, channel);
      if (post) parsed.push(post);
    }
    return parsed;
  }

  /**
   * The only way to resolve a post id that has scrolled out of the 100-post
   * window. Returns every post in the thread, which is why backfill should
   * dedupe against what it already recovered before issuing the next request.
   *
   * Throws PermanentPostError on 5xx — confirmed reproducible for ids 14280,
   * 17480 and 18440. Callers must record and skip, never retry.
   */
  async getThread(postId: number): Promise<MusebookPost[]> {
    const raw = (await this.request(`/api/thread.json?post=${encodeURIComponent(String(postId))}`, {
      treat5xxAsPermanent: { postId },
      retries: 1,
    })) as { thread?: unknown; channel?: unknown };
    const channel = typeof raw.channel === "string" ? raw.channel : "";
    return flattenThread(raw.thread, channel);
  }

  async getIdentity(museId: string): Promise<MusebookIdentity | null> {
    const raw = await this.request(`/api/identity.json?muse_id=${encodeURIComponent(museId)}`);
    return parseIdentity(raw);
  }

  async getRoster(): Promise<MusebookIdentity[]> {
    const raw = await this.request("/api/muses.json");
    const muses = (raw as { muses?: unknown }).muses;
    if (!Array.isArray(muses)) return [];
    const parsed: MusebookIdentity[] = [];
    for (const item of muses) {
      const identity = parseIdentity(item);
      if (identity) parsed.push(identity);
    }
    return parsed;
  }

  /** Reply in-thread. `parent_post_id` must live in the same channel. */
  async createPost(input: {
    channel: string;
    text: string;
    name: string;
    parentPostId?: number | null;
  }): Promise<CreatedPost> {
    const { museId, privateKey } = this.requireSigning();
    const fields: Record<string, string | number> = {
      channel: input.channel,
      name: input.name,
      text: input.text,
    };
    if (input.parentPostId != null) fields.parent_post_id = input.parentPostId;
    const body = signRequest("post", museId, privateKey, fields);
    const raw = (await this.request("/api/post", { method: "POST", body, retries: 0 })) as {
      post?: { id?: number; channel?: string; parent_post_id?: number | null };
      id?: number;
    };
    const id = raw.post?.id ?? raw.id;
    if (typeof id !== "number") {
      throw new Error(`musebook accepted the post but returned no id: ${JSON.stringify(raw).slice(0, 200)}`);
    }
    return {
      id,
      channel: raw.post?.channel ?? input.channel,
      parent_post_id: raw.post?.parent_post_id ?? input.parentPostId ?? null,
    };
  }

  /**
   * React to a post. Tier-1 acknowledgement.
   *
   * Reactions toggle: the same emoji twice removes it, so callers must track
   * what they have already placed. The emoji must be one of musebook's twelve.
   *
   * UNVERIFIED: whether this counts against the 20 musings/hour/IP write
   * limit. The whole acknowledgement ladder assumes it does not. See
   * docs/muse-agent.md for the test, which needs a registered keypair.
   */
  async react(postId: number, emoji: string): Promise<{ reacted: boolean; counts: Record<string, number> }> {
    if (!ALLOWED_REACTIONS.includes(emoji)) {
      throw new Error(`"${emoji}" is not one of musebook's twelve reactions: ${ALLOWED_REACTIONS.join(" ")}`);
    }
    const { museId, privateKey } = this.requireSigning();
    const body = signRequest("react", museId, privateKey, { post_id: postId, emoji });
    const raw = (await this.request("/api/react", { method: "POST", body, retries: 0 })) as {
      reacted?: boolean;
      counts?: Record<string, number>;
    };
    return { reacted: raw.reacted !== false, counts: raw.counts ?? {} };
  }

  /**
   * Registration. Unsigned by design — this is where the keypair is introduced.
   *
   * NOTE: `text` is a real post in #lobby. Calling this publishes publicly.
   */
  async intro(input: {
    name: string;
    publicKey: string;
    text: string;
    bio?: string;
    avatarUrl?: string;
    visibility?: "anonymous" | "linked";
    idempotencyKey: string;
    museId?: string;
  }): Promise<{ museId: string; deduped: boolean; raw: unknown }> {
    const body: Record<string, string> = {
      name: input.name,
      public_key: input.publicKey,
      text: input.text,
      visibility: input.visibility ?? "anonymous",
      idempotency_key: input.idempotencyKey,
    };
    if (input.bio) body.bio = input.bio;
    if (input.avatarUrl) body.avatar_url = input.avatarUrl;
    if (input.museId) body.muse_id = input.museId;
    const raw = (await this.request("/api/intro", { method: "POST", body, retries: 0 })) as {
      muse?: { muse_id?: string };
      deduped?: boolean;
    };
    const museId = raw.muse?.muse_id;
    if (!museId) throw new Error(`intro returned no muse_id: ${JSON.stringify(raw).slice(0, 200)}`);
    return { museId, deduped: raw.deduped === true, raw };
  }
}

function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 30_000);
}
