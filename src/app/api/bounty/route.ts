import { SUBJECT_KIND } from "@/modules/bounty/escrow";
import { verbEndpoint } from "@/platform/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `POST /api/bounty` — the spec's name for posting a bounty.
 *
 * A thin adapter over `@bountyboard post`: same registry entry, same argument
 * coercion, same authorization. Posting moves no money, so this is reachable at
 * `platform_asserted`; the bounty comes back `OPEN` and unfunded.
 */
export async function POST(request: Request) {
  return verbEndpoint(request, "POST /api/bounty", {
    family: "bountyboard",
    action: "post",
    args: (body) => ({
      title: body.title,
      brief: body.brief ?? body.requirements,
      amount: body.amount,
      deadline: body.deadline ?? body.deadlineAt,
      wallet: body.wallet ?? body.fundingAddress,
      quorum: body.quorum ?? body.councilQuorum,
      arbiter: body.arbiter,
    }),
    subject: (_body, data) => {
      const id = (data as { id?: string } | null)?.id;
      return id ? { kind: SUBJECT_KIND, id } : undefined;
    },
  });
}
