import { getBounty, submitWork, SUBJECT_KIND } from "@/modules/bounty/escrow";
import {
  bountyView,
  payoutView,
  releaseRequiresSignature,
  submissionView,
} from "@/modules/bounty/view";
import { mutationEndpoint } from "@/platform/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return mutationEndpoint(
    request,
    "POST /api/bounties/[id]/submissions",
    async ({ actor, body }) => {
      const submission = await submitWork(id, {
        worker: actor,
        artifactUrl: String(body.artifactUrl ?? body.url ?? ""),
        rewardAddress:
          body.rewardAddress || body.wallet
            ? String(body.rewardAddress ?? body.wallet)
            : undefined,
        rewardAddressSignature:
          typeof body.signature === "string" ? body.signature : undefined,
        notes: typeof body.notes === "string" ? body.notes : undefined,
      });
      const bounty = await getBounty(id);
      return {
        status: 201,
        body: {
          submission: submissionView(submission),
          bounty: bountyView(bounty),
          payout: payoutView(submission),
          release_requires_evm_signature: releaseRequiresSignature(
            bounty,
            submission,
          ),
        },
        receiptSubject: { kind: SUBJECT_KIND, id },
      };
    },
  );
}
