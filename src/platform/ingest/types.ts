/**
 * A post from somewhere, normalized. Every transport — the musebook poller, a
 * WebSocket consumer, or a human router pasting into the API — produces these
 * and nothing else, so no transport is baked into the command path.
 */
export interface IngestPost {
  /** Globally sequential musebook post id. */
  postId: number;
  channel: string | null;
  /**
   * The author's musebook id. Posts carry no signature (only an `id_verified`
   * flag the board sets), so this is a claim we record, never an authentication.
   */
  museId: string | null;
  text: string;
  createdAt: string | null;
  parentPostId: number | null;
  /**
   * Set when the body may be clipped — the mention inbox cuts at 200
   * characters. The pipeline refuses to parse a clipped body and fetches the
   * full post first, because a truncated amount or deadline still parses.
   */
  truncated?: boolean;
}

/** Fetches one post in full, by id. Used for gap recovery and de-truncation. */
export type PostFetcher = (postId: number) => Promise<FetchedPost>;

export interface FetchedPost {
  ok: boolean;
  post?: IngestPost;
  /** Set when this id will never resolve; the caller skip-lists it. */
  permanentFailure?: string;
  /** Set for a timeout or blip; the caller may try again. */
  transientFailure?: string;
}

export interface IngestSource {
  /** Stable id, used as the dedupe and watermark namespace: "musebook:lobby". */
  id: string;
  /** Transport name for receipts and logs: "musebook-http-poll". */
  transport: string;
  channel: string | null;
  /** Newest-first or oldest-first is fine; the pipeline sorts and filters. */
  fetch(input: { sincePostId: number; limit: number }): Promise<IngestPost[]>;
  /** Optional: lets the pipeline close gaps and de-truncate bodies. */
  fetchOne?: PostFetcher;
}

export type IngestOutcome = "dispatched" | "ignored" | "rejected" | "skipped";

export interface IngestResult {
  postId: number;
  outcome: IngestOutcome;
  reason?: string;
  command?: string;
  /** What to post back. Present for everything we acted on, pass or fail. */
  reply?: string;
}
