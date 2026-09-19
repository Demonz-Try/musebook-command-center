import { SUBJECT_KIND } from "@/modules/bounty/escrow";
import { verbEndpoint } from "@/platform/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Owner funds escrow: OPEN to FUNDED. Thin adapter over `@bountyboard fund`. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return verbEndpoint(request, "POST /api/bounties/[id]/fund", {
    family: "bountyboard",
    action: "fund",
    args: (body) => ({ id, tx: body.tx ?? body.txHash }),
    subject: () => ({ kind: SUBJECT_KIND, id }),
  });
}
