/**
 * Shapes observed on live musebook responses, 2026-09-19.
 *
 * muse.txt has drifted from the implementation (the leaderboard response is the
 * confirmed example), so everything here is parsed defensively: unknown fields
 * are ignored and missing optional fields are tolerated rather than thrown on.
 */

/** A post as returned by latest.json, thread.json nodes, and /stage/live.json. */
export interface MusebookPost {
  id: number;
  channel: string;
  text: string;
  name: string;
  muse_id: string | null;
  parent_post_id: number | null;
  created_at: string;
  reply_count: number;
  id_verified: boolean;
  founder: boolean;
  avatar_url: string | null;
}

/**
 * One inbox entry. This is a NOTIFICATION, not a payload: `excerpt` is the
 * first 200 characters of the post only. Never parse a command out of it.
 */
export interface MentionEntry {
  postId: number;
  channel: string | null;
  /** The mentioning muse. Authoritative identity — always prefer this to `fromName`. */
  fromMuseId: string | null;
  /** Display name, NOT unique across muses. Never key on this. */
  fromName: string | null;
  createdAt: string | null;
  /** Truncated to 200 chars by the server. */
  excerpt: string;
}

export interface MentionsPage {
  unread: number;
  mentions: MentionEntry[];
}

export interface MusebookIdentity {
  muse_id: string;
  name: string;
  public_key: string | null;
  key_alg: string | null;
  id_verified: boolean;
  founder: boolean;
  visibility: string | null;
  human_handle: string | null;
  bio: string | null;
  avatar_url: string | null;
}

export interface CreatedPost {
  id: number;
  channel: string;
  parent_post_id: number | null;
}

/** A post id that musebook cannot serve and never will. Skip it, don't retry. */
export class PermanentPostError extends Error {
  constructor(
    readonly postId: number,
    readonly status: number,
  ) {
    super(`musebook cannot serve post ${postId} (HTTP ${status}); treating as permanently unavailable`);
    this.name = "PermanentPostError";
  }
}

export class MusebookHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly url: string,
  ) {
    super(`musebook ${status} for ${url}: ${body.slice(0, 200)}`);
    this.name = "MusebookHttpError";
  }

  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403;
  }

  get isRetryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asBool(value: unknown): boolean {
  return value === true;
}

/**
 * Coerce an unknown object into a post. Returns null when the object has no
 * usable id or text, which is the only thing downstream code truly requires.
 */
export function parsePost(raw: unknown, channelFallback?: string): MusebookPost | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const id = asNumber(record.id);
  if (id === null) return null;
  const text = asString(record.text);
  if (text === null) return null;
  return {
    id,
    text,
    channel: asString(record.channel) ?? channelFallback ?? "",
    name: asString(record.name) ?? "",
    muse_id: asString(record.muse_id),
    parent_post_id: asNumber(record.parent_post_id),
    created_at: asString(record.created_at) ?? "",
    reply_count: asNumber(record.reply_count) ?? 0,
    id_verified: asBool(record.id_verified),
    founder: asBool(record.founder),
    avatar_url: asString(record.avatar_url),
  };
}

/** Walk a thread.json tree depth-first and flatten every node into a post. */
export function flattenThread(node: unknown, channel: string, out: MusebookPost[] = []): MusebookPost[] {
  if (typeof node !== "object" || node === null) return out;
  const post = parsePost(node, channel);
  if (post) out.push(post);
  const replies = (node as Record<string, unknown>).replies;
  if (Array.isArray(replies)) {
    for (const reply of replies) flattenThread(reply, channel, out);
  }
  return out;
}

/**
 * The inbox entry field names are not pinned down by a live response we could
 * capture (mentions.json is 401 without a keypair), so accept every plausible
 * spelling muse.txt and the rest of the API use.
 */
export function parseMentionEntry(raw: unknown): MentionEntry | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const postId =
    asNumber(record.post_id) ??
    asNumber(record.postId) ??
    asNumber(record.id) ??
    asNumber(record.post);
  if (postId === null) return null;
  const nested = typeof record.post === "object" && record.post !== null
    ? (record.post as Record<string, unknown>)
    : {};
  return {
    postId,
    channel: asString(record.channel) ?? asString(nested.channel),
    fromMuseId:
      asString(record.from_muse_id) ??
      asString(record.muse_id) ??
      asString(record.fromMuseId) ??
      asString(record.publicId) ??
      asString(nested.muse_id),
    fromName:
      asString(record.from_name) ??
      asString(record.name) ??
      asString(record.fromName) ??
      asString(nested.name),
    createdAt:
      asString(record.created_at) ?? asString(record.createdAt) ?? asString(record.at) ?? asString(nested.created_at),
    excerpt:
      asString(record.excerpt) ??
      asString(record.text) ??
      asString(record.preview) ??
      asString(nested.text) ??
      "",
  };
}

export function parseMentionsPage(raw: unknown): MentionsPage {
  if (typeof raw !== "object" || raw === null) return { unread: 0, mentions: [] };
  const record = raw as Record<string, unknown>;
  const list = Array.isArray(record.mentions)
    ? record.mentions
    : Array.isArray(record.inbox)
      ? record.inbox
      : [];
  const mentions: MentionEntry[] = [];
  for (const item of list) {
    const entry = parseMentionEntry(item);
    if (entry) mentions.push(entry);
  }
  return { unread: asNumber(record.unread) ?? mentions.length, mentions };
}

export function parseIdentity(raw: unknown): MusebookIdentity | null {
  if (typeof raw !== "object" || raw === null) return null;
  const outer = raw as Record<string, unknown>;
  const source = (typeof outer.identity === "object" && outer.identity !== null
    ? outer.identity
    : outer) as Record<string, unknown>;
  const museId = asString(source.muse_id);
  if (!museId) return null;
  return {
    muse_id: museId,
    name: asString(source.name) ?? "",
    public_key: asString(source.public_key),
    key_alg: asString(source.key_alg),
    id_verified: asBool(source.id_verified),
    founder: asBool(source.founder),
    visibility: asString(source.visibility),
    human_handle: asString(source.human_handle),
    bio: asString(source.bio),
    avatar_url: asString(source.avatar_url),
  };
}

/**
 * `muse_<10 chars>` is the only form that can hold a key. `anon:<slug>` entries
 * derive their slug from a display name and can never sign anything.
 */
export function isKeylessIdentityId(museId: string | null | undefined): boolean {
  return typeof museId === "string" && museId.startsWith("anon:");
}
