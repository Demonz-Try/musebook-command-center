import { getBounty, releaseEscrow, SUBJECT_KIND } from "@/modules/bounty/escrow";
import { bountyView } from "@/modules/bounty/view";
import { firstPartyGrant } from "@/platform/capabilities";
import { mutationEndpoint } from "@/platform/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `POST /api/bounties/<id>/release` — execute a decided release.
 *
 * Permissionless for every outcome a public process decided. A council vote
 * that resolved is not the council's to withhold afterwards, and a lapsed
 * deadline is not the owner's to sit on, so anyone may call this and everyone
 * who does gets the identical result. The scheduled deadline checker calls the
 * same function with the same rights; there is no privileged variant of it.
 *
 * It cannot be aimed: the payee and its address were fixed when the decision
 * was recorded, and nothing in this request can change either.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return mutationEndpoint(
    request,
    `POST /api/bounties/${id}/release`,
    async ({ actor, body }) => {
      const bounty = await releaseEscrow(id, {
        actor,
        txHash: typeof body.txHash === "string" ? body.txHash : undefined,
        // The capability belongs to the platform, not the caller: the rules
        // that decide where this money goes were enforced when the decision was
        // recorded, and this step only carries them out.
        capabilities: firstPartyGrant("release-endpoint", ["value.move"]),
      });
      return {
        status: 200,
        body: {
          bounty: bountyView(await getBounty(bounty.id)),
          message: `Escrow ${bounty.escrow} to ${bounty.settledTo}; bounty ${bounty.id} is ${bounty.status}.`,
        },
        receiptSubject: { kind: SUBJECT_KIND, id },
      };
    },
  );
}
