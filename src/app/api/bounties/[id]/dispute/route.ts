import { SUBJECT_KIND } from "@/modules/bounty/escrow";
import { verbEndpoint } from "@/platform/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Escalate to the public council: IN_REVIEW to DISPUTED. Thin adapter over `@bountyboard dispute`. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return verbEndpoint(request, "POST /api/bounties/[id]/dispute", {
    family: "bountyboard",
    action: "dispute",
    args: (body) => ({ id, reason: body.reason }),
    subject: () => ({ kind: SUBJECT_KIND, id }),
  });
}
