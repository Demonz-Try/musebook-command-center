import { SUBJECT_KIND } from "@/modules/bounty/escrow";
import { verbEndpoint } from "@/platform/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `POST /api/fund` — the spec's separate funding step, and the first one that
 * moves money. Unlike `/api/bounty`, this needs a `key_bound` caller, which the
 * registry enforces because this is the same command path a mention takes.
 */
export async function POST(request: Request) {
  return verbEndpoint(request, "POST /api/fund", {
    family: "bountyboard",
    action: "fund",
    args: (body) => ({
      id: body.id ?? body.bountyId,
      tx: body.tx ?? body.txHash,
      // Checked against the bounty's declared wallet rather than recorded: the
      // contract would have refused any other sender, so a mismatch means our
      // record and the chain disagree.
      from: body.from ?? body.fromAddress ?? body.sender,
    }),
    subject: (body) => ({ kind: SUBJECT_KIND, id: String(body.id ?? body.bountyId) }),
  });
}
