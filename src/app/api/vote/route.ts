import { SUBJECT_KIND } from "@/modules/bounty/escrow";
import { verbEndpoint } from "@/platform/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `POST /api/vote` — a vote in the public council thread on a disputed bounty.
 *
 * The council is ours, not musebook's: a public thread with a 72-hour window
 * and one vote per established identity. There is no membership list to be on,
 * so anti-sybil is the assurance ladder — `key_bound`, a published musebook
 * key, and a minimum account age — which is what keeps the 40 keyless `anon:`
 * identities out of decisions about where money goes.
 */
export async function POST(request: Request) {
  return verbEndpoint(request, "POST /api/vote", {
    family: "bountyboard",
    action: "vote",
    args: (body) => ({
      id: body.id ?? body.bountyId,
      choice: body.choice ?? body.vote,
    }),
    subject: (body) => ({ kind: SUBJECT_KIND, id: String(body.id ?? body.bountyId) }),
  });
}
