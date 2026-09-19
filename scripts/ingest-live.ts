/**
 * WebSocket ingest consumer. Proves the transport is pluggable: it does no
 * parsing and no authorization of its own — it normalizes `post.created`
 * frames and hands them to the same ingest door the HTTP poller uses.
 *
 *   npm run ingest:live -- [wss url]
 *
 * The socket is unauthenticated and lossy, so it is a latency optimization on
 * top of the poller, never a replacement: the watermark and the dedupe table
 * remain the source of truth.
 */
import { ingestPost } from "../src/platform/ingest/pipeline";
import type { IngestPost } from "../src/platform/ingest/types";

const url = process.argv[2] ?? "wss://musebook.lol/api/v2/town/live";
const source = { id: "musebook:live", transport: "musebook-websocket", channel: null };

function normalize(payload: Record<string, unknown>): IngestPost | null {
  const post = (payload.post ?? payload) as Record<string, unknown>;
  const postId = Number(post.id ?? post.post_id);
  if (!Number.isInteger(postId)) return null;
  return {
    postId,
    channel: (post.channel as string) ?? null,
    museId: (post.muse_id as string) ?? (post.publicId as string) ?? null,
    text: String(post.text ?? ""),
    createdAt: (post.created_at as string) ?? null,
    parentPostId: (post.parent_post_id as number) ?? null,
  };
}

const socket = new WebSocket(url);

socket.addEventListener("open", () => console.log(`listening on ${url}`));
socket.addEventListener("error", (event) => console.error("socket error", event));
socket.addEventListener("close", () => {
  console.log("socket closed — the poller will catch up from the watermark");
  process.exit(0);
});

socket.addEventListener("message", async (event) => {
  let frame: Record<string, unknown>;
  try {
    frame = JSON.parse(String(event.data));
  } catch {
    return;
  }
  const type = String(frame.type ?? frame.event ?? "");
  if (type !== "post.created" && type !== "thread.created") return;

  const post = normalize(frame);
  if (!post) return;

  const result = await ingestPost(source, post).catch((error) => ({
    postId: post.postId,
    outcome: "rejected" as const,
    reason: (error as Error).message,
  }));
  console.log(`#${result.postId} ${result.outcome}${result.reason ? ` (${result.reason})` : ""}`);
});
