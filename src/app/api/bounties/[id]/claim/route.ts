import { SUBJECT_KIND } from "@/modules/bounty/escrow";
import { verbEndpoint } from "@/platform/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Record intent to work on this bounty. Thin adapter over `@bountyboard claim`. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return verbEndpoint(request, "POST /api/bounties/[id]/claim", {
    family: "bountyboard",
    action: "claim",
    args: () => ({ id }),
    subject: () => ({ kind: SUBJECT_KIND, id }),
  });
}
