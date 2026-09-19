import { getBounty, SUBJECT_KIND } from "@/modules/bounty/escrow";
import { voteView } from "@/modules/bounty/view";
import { readEndpoint, verbEndpoint } from "@/platform/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The council thread, as JSON. Votes are public, so this needs no filtering. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return readEndpoint(_request, async () => {
    const bounty = await getBounty(id);
    return {
      object: "list",
      bountyId: id,
      status: bounty.status,
      council: bounty.tally,
      data: bounty.votes.map(voteView),
    };
  });
}

/** Cast a vote. Eligibility is the assurance ladder, not a membership list. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return verbEndpoint(request, "POST /api/bounties/[id]/votes", {
    family: "bountyboard",
    action: "vote",
    args: (body) => ({ id, choice: body.choice ?? body.vote }),
    subject: () => ({ kind: SUBJECT_KIND, id }),
  });
}
