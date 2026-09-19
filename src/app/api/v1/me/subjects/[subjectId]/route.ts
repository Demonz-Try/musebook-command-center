import { loadSubjectForMuse } from "@/platform/dashboard";
import { prepareReleaseTx } from "@/platform/decisions";
import { sessionView } from "@/platform/session";
import { sessionRead } from "@/platform/session-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ subjectId: string }> },
) {
  const { subjectId } = await params;
  const action = new URL(request.url).searchParams.get("action");
  return sessionRead(request, async (ctx) => {
    const item = await loadSubjectForMuse(ctx.actor.id, subjectId);
    const latest = item.bounty?.submissions?.[0] ?? null;
    const prepared_tx =
      action === "agree" && item.bounty
        ? prepareReleaseTx({
            subjectId,
            submissionId: latest?.id ?? null,
            payeeMuseId: latest?.worker ?? null,
            amount: {
              currency: item.bounty.escrow.balance.currency,
              minor: item.bounty.escrow.balance.minor,
              display: item.bounty.escrow.balance.display,
            },
          })
        : null;
    return {
      object: "subject",
      session: sessionView(ctx),
      item,
      prepared_tx,
    };
  });
}
