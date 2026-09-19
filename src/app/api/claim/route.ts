import { SUBJECT_KIND } from "@/modules/bounty/escrow";
import { verbEndpoint } from "@/platform/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `POST /api/claim` — stating intent to work on a bounty. It moves no money and
 * changes no status, so a claim cannot be used to lock a bounty against others.
 */
export async function POST(request: Request) {
  return verbEndpoint(request, "POST /api/claim", {
    family: "bountyboard",
    action: "claim",
    args: (body) => ({ id: body.id ?? body.bountyId }),
    subject: (body) => ({ kind: SUBJECT_KIND, id: String(body.id ?? body.bountyId) }),
  });
}
