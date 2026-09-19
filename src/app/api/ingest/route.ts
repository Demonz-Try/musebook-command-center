import { authenticateScheduler } from "@/platform/auth";
import { loadModules } from "@/platform/bootstrap";
import { fail, jsonBody, ok } from "@/platform/http";
import { PlatformError } from "@/platform/errors";
import { getWatermark, ingestPost, pollSource } from "@/platform/ingest/pipeline";
import {
  configuredChannels,
  musebookChannelSource,
} from "@/platform/ingest/musebook";
import type { IngestPost } from "@/platform/ingest/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Watermarks and configured sources, so an operator can see where we are. */
export async function GET() {
  const channels = configuredChannels();
  const sources = await Promise.all(
    channels.map(async (channel) => ({
      id: `musebook:${channel}`,
      transport: "musebook-http-poll",
      channel,
      highWatermarkPostId: await getWatermark(`musebook:${channel}`),
    })),
  );
  return ok({ object: "ingest_status", sources });
}

/**
 * One ingest door for every transport. A human router, the HTTP poller and a
 * WebSocket consumer all arrive here: either push normalized posts, or ask the
 * server to poll a channel itself.
 */
export async function POST(request: Request) {
  try {
    loadModules();
    authenticateScheduler(request);
    const body = await jsonBody(request);

    if (Array.isArray(body.posts)) {
      const transport = typeof body.transport === "string" ? body.transport : "push";
      const sourceId = typeof body.source === "string" ? body.source : `push:${transport}`;
      const results = [];
      for (const raw of body.posts as IngestPost[]) {
        if (typeof raw?.postId !== "number") {
          throw new PlatformError("validation", "each post needs a numeric postId");
        }
        results.push(
          await ingestPost(
            { id: sourceId, transport, channel: raw.channel ?? null },
            {
              postId: raw.postId,
              channel: raw.channel ?? null,
              museId: raw.museId ?? null,
              text: String(raw.text ?? ""),
              createdAt: raw.createdAt ?? null,
              parentPostId: raw.parentPostId ?? null,
            },
          ),
        );
      }
      return ok({ object: "ingest_run", source: sourceId, results });
    }

    const channel = typeof body.channel === "string" ? body.channel : null;
    const channels = channel ? [channel] : configuredChannels();
    if (channels.length === 0) {
      throw new PlatformError(
        "validation",
        'no channel given and MUSEBOOK_INGEST_CHANNELS is empty — send {"channel":"lobby"} or {"posts":[…]}',
      );
    }

    const runs = [];
    for (const slug of channels) {
      runs.push(await pollSource(musebookChannelSource(slug)));
    }
    return ok({ object: "ingest_run", runs });
  } catch (error) {
    return fail(error);
  }
}
