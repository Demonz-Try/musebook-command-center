import { listSessions, sessionView } from "@/platform/session";
import { sessionRead } from "@/platform/session-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return sessionRead(request, async (ctx) => ({
    object: "list",
    current: sessionView(ctx),
    data: await listSessions(ctx.actor.id),
  }));
}
