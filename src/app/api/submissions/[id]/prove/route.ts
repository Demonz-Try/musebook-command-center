import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { SUBJECT_KIND } from "@/modules/bounty/escrow";
import { submissionWithBounty } from "@/modules/bounty/queries";
import { submissions } from "@/modules/bounty/schema";
import {
  payoutView,
  releaseRequiresSignature,
  submissionView,
} from "@/modules/bounty/view";
import { proofStatement, verifyProof } from "@/platform/address-proof";
import { PlatformError } from "@/platform/errors";
import { mutationEndpoint, readEndpoint } from "@/platform/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `GET /api/submissions/<id>/prove` — the exact bytes to sign.
 *
 * Handed out rather than described, because a statement the caller reconstructs
 * from prose is a statement that will differ by a newline and fail to verify.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return readEndpoint(request, async () => {
    const found = await submissionWithBounty(id);
    if (!found) throw new PlatformError("not_found", `no submission ${id}`);

    return {
      object: "proof_challenge",
      submissionId: found.submission.id,
      address: found.submission.rewardAddress,
      proven: Boolean(found.submission.rewardAddressProvenAt),
      method: "eip191",
      statement: proofStatement({
        address: found.submission.rewardAddress,
        subject: `bounty:${found.bounty.id}`,
        nonce: found.submission.worker,
      }),
      instructions:
        "Sign this string with the reward address's key using personal_sign, then POST {\"signature\":\"0x…\"} back here.",
    };
  });
}

/**
 * `POST /api/submissions/<id>/prove` — prove control of the reward address.
 *
 * Deliberately open to anyone holding the key rather than restricted to the
 * submitter's session: the thing being proved is control of the address, and a
 * signature from it is better evidence of that than any session could be.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return mutationEndpoint(
    request,
    `POST /api/submissions/${id}/prove`,
    async ({ body }) => {
      const found = await submissionWithBounty(id);
      if (!found) throw new PlatformError("not_found", `no submission ${id}`);

      const proof = verifyProof({
        address: found.submission.rewardAddress,
        statement: proofStatement({
          address: found.submission.rewardAddress,
          subject: `bounty:${found.bounty.id}`,
          nonce: found.submission.worker,
        }),
        signature: String(body.signature ?? ""),
      });

      const db = await getDb();
      const [updated] = await db
        .update(submissions)
        .set({
          rewardAddressProvenAt: proof.provenAt,
          rewardAddressProofMethod: proof.method,
          rewardAddressProof: proof.evidence,
        })
        .where(eq(submissions.id, id))
        .returning();

      return {
        status: 200,
        body: {
          object: "proof",
          submission: submissionView(updated),
          payout: payoutView(updated),
          release_requires_evm_signature: releaseRequiresSignature(
            found.bounty,
            updated,
          ),
          message: `${found.submission.rewardAddress} is proven; submission ${id} is now payable.`,
        },
        receiptSubject: { kind: SUBJECT_KIND, id: found.bounty.id },
      };
    },
  );
}
