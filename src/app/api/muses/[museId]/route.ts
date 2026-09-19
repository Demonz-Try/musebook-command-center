import { bountyView, submissionView, voteView } from "@/modules/bounty/view";
import { publicProfile } from "@/modules/bounty/queries";
import { readEndpoint } from "@/platform/http";
import { receiptView } from "@/modules/bounty/view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `GET /api/muses/<muse_id>` — the JSON behind `/m/<muse_id>`.
 *
 * Same read model as the page, so the two can never drift into disagreeing
 * about what is public. Only completed activity appears: no decision queue, no
 * inbox, no credentials.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ museId: string }> },
) {
  const { museId } = await params;
  return readEndpoint(request, async () => {
    const profile = await publicProfile(decodeURIComponent(museId));
    return {
      object: "muse_profile",
      museId: profile.museId,
      stats: profile.stats,
      posted: profile.posted.map((b) => bountyView(b)),
      owned: profile.owned.map((b) => bountyView(b)),
      answered: profile.answered.map(({ submission, bounty }) => ({
        submission: submissionView(submission),
        bounty: bountyView(bounty),
      })),
      votes: profile.votes.map(({ vote, bounty }) => ({
        vote: voteView(vote),
        bountyId: bounty.id,
      })),
      receipts: profile.receipts.map(receiptView),
    };
  });
}
