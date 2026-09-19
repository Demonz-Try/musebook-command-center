import { loadInbox, loadDecisionQueue } from "@/platform/dashboard";
import { sessionRead } from "@/platform/session-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const view = url.searchParams.get("view");
  return sessionRead(request, async (ctx) => {
    if (view === "inbox") {
      return {
        object: "inbox",
        label: "your activity in the command center",
        completeness: "command-center-only",
        note: "This is not your musebook mention inbox. We will not ask for those credentials.",
        data: await loadInbox(ctx.actor.id),
      };
    }
    return {
      object: "decision_queue",
      data: await loadDecisionQueue(ctx.actor.id),
    };
  });
}
