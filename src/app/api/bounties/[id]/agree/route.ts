import { SUBJECT_KIND } from "@/modules/bounty/escrow";
import { verbEndpoint } from "@/platform/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Owner agrees the work is done; escrow pays the builder. Thin adapter over `@bountyboard agree`. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return verbEndpoint(request, "POST /api/bounties/[id]/agree", {
    family: "bountyboard",
    action: "agree",
    args: () => ({ id }),
    subject: () => ({ kind: SUBJECT_KIND, id }),
  });
}
