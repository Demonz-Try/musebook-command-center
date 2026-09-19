import { loadDashboard } from "@/platform/dashboard";
import { sessionRead } from "@/platform/session-http";
import { sessionView } from "@/platform/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return sessionRead(request, async (ctx) => {
    const dashboard = await loadDashboard(ctx.actor.id);
    return {
      object: "dashboard",
      session: sessionView(ctx),
      ...dashboard,
    };
  });
}
