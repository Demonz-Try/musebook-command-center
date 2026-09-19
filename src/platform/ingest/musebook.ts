import { PlatformError } from "../errors";
import type { FetchedPost, IngestPost, IngestSource } from "./types";

export const MUSEBOOK_BASE = process.env.MUSEBOOK_BASE_URL ?? "https://musebook.lol";

/**
 * Shapes verified against the live board on 2026-09-19. Two things differ from
 * `muse.txt`: muse ids are not always ten characters (`muse_wynjr` is five),
 * and `v2/town/state` calls the same field `publicId` rather than `muse_id`.
 */
export interface MusebookPost {
  id: number;
  name: string;
  text: string;
  /** "YYYY-MM-DD HH:MM:SS" — not ISO 8601, and with no timezone marker. */
  created_at: string;
  muse_id: string | null;
  parent_post_id: number | null;
  reply_count: number;
  channel: string;
  id_verified?: boolean;
}

function normalize(post: MusebookPost, fallbackChannel: string): IngestPost {
  return {
    postId: post.id,
    channel: post.channel ?? fallbackChannel,
    museId: post.muse_id ?? null,
    text: post.text ?? "",
    createdAt: post.created_at ?? null,
    parentPostId: post.parent_post_id ?? null,
  };
}

async function readJson(url: string, timeoutMs = 15_000): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new PlatformError(
      "not_found",
      `${url} responded ${response.status}`,
    );
  }
  return response.json();
}

/**
 * Reads a channel through `latest.json`. The endpoint takes only `limit`
 * (capped at 100) — `offset`, `before` and `since` are accepted and silently
 * ignored — so catching up is a matter of polling often enough and discarding
 * everything at or below the watermark.
 */
export function musebookChannelSource(channel: string): IngestSource {
  return {
    id: `musebook:${channel}`,
    transport: "musebook-http-poll",
    channel,
    async fetch({ limit }) {
      const url = `${MUSEBOOK_BASE}/api/latest.json?channel=${encodeURIComponent(channel)}&limit=${Math.min(limit, 100)}`;
      const body = (await readJson(url)) as { posts?: MusebookPost[] };
      if (!Array.isArray(body.posts)) {
        throw new PlatformError("validation", `${url} returned no posts array`);
      }
      return body.posts.map((post) => normalize(post, channel));
    },
    fetchOne: fetchPost,
  };
}

/**
 * A source fed by somebody else — a human router pasting posts in, or the
 * WebSocket consumer in `scripts/ingest-live.ts`. Same interface, so the
 * pipeline cannot tell the difference.
 */
export function pushSource(
  id: string,
  transport: string,
  posts: IngestPost[],
): IngestSource {
  return {
    id,
    transport,
    channel: posts[0]?.channel ?? null,
    async fetch() {
      return posts;
    },
    fetchOne: fetchPost,
  };
}

/**
 * Fetches one post in full through `thread.json`.
 *
 * Two jobs. It closes gaps, because there is no pagination and no backfill past
 * the 100-post window. And it replaces a truncated body: the mention inbox
 * clips at 200 characters, and a clipped amount or deadline still parses, which
 * is the silent-corruption case rather than an error case.
 *
 * `thread.json` 500s reproducibly for roughly one id in twenty. A 5xx is
 * reported as permanent so the caller writes the id off instead of retrying it
 * forever; a timeout is reported as transient so the next poll tries again.
 */
export async function fetchPost(postId: number): Promise<FetchedPost> {
  const url = `${MUSEBOOK_BASE}/api/thread.json?post=${postId}`;
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status >= 500) {
      return { ok: false, permanentFailure: `thread.json responded ${response.status}` };
    }
    if (response.status === 404) {
      return { ok: false, permanentFailure: "thread.json responded 404" };
    }
    if (!response.ok) {
      return { ok: false, transientFailure: `thread.json responded ${response.status}` };
    }

    const body = (await response.json()) as {
      post?: MusebookPost;
      posts?: MusebookPost[];
    };
    const root =
      body.post ?? body.posts?.find((candidate) => candidate.id === postId);
    if (!root) {
      return { ok: false, permanentFailure: `thread.json returned no post ${postId}` };
    }
    return { ok: true, post: normalize(root, root.channel ?? "") };
  } catch (error) {
    return { ok: false, transientFailure: (error as Error).message };
  }
}

export function configuredChannels(): string[] {
  return (process.env.MUSEBOOK_INGEST_CHANNELS ?? "")
    .split(",")
    .map((slug) => slug.trim())
    .filter(Boolean);
}
