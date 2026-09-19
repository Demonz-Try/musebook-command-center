import { applyDashboardDecision } from "@/platform/decisions";
import { listDecisions } from "@/platform/dashboard";
import { sessionMutate, sessionRead } from "@/platform/session-http";
import { PlatformError } from "@/platform/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return sessionRead(request, async (ctx) => ({
    object: "list",
    data: await listDecisions(ctx.actor.id),
  }));
}

export async function POST(request: Request) {
  return sessionMutate(
    request,
    async ({ actor, scope, body }) => {
      const subjectId =
        typeof body.subject_id === "string"
          ? body.subject_id
          : typeof body.subjectId === "string"
            ? body.subjectId
            : "";
      const action = typeof body.action === "string" ? body.action : "";
      if (!subjectId || !action) {
        throw new PlatformError("validation", "subject_id and action are required");
      }
      const result = await applyDashboardDecision({
        museId: actor.id,
        subjectId,
        subjectKind: typeof body.subject_kind === "string" ? body.subject_kind : undefined,
        action,
        scope,
      });
      return {
        body: {
          object: "decision",
          funds_moved: result.funds_moved,
          executed: result.executed,
          assurance: result.assurance,
          action: result.action,
          mention: result.mention,
          prepared_tx: result.prepared_tx,
          decision: result.decision,
          subject: result.subject,
        },
      };
    },
    { minScope: "elevated" },
  );
}
