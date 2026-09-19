import { SUBJECT_KIND } from "@/modules/bounty/escrow";
import { verbEndpoint } from "@/platform/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `POST /api/decide` — the owner's verdict on work in review.
 *
 * `{"decision":"agree"}` releases escrow to the builder; `{"decision":"dispute"}`
 * opens the 72-hour public council window. There is no third decision, and in
 * particular no way for an owner to move the money anywhere but to the builder.
 */
export async function POST(request: Request) {
  const body = await request.clone().json().catch(() => ({}) as Record<string, unknown>);
  const decision = String((body as Record<string, unknown>).decision ?? "agree");
  const action = decision === "dispute" || decision === "reject" ? "dispute" : "agree";

  return verbEndpoint(request, "POST /api/decide", {
    family: "bountyboard",
    action,
    args: (b) =>
      action === "dispute"
        ? { id: b.id ?? b.bountyId, reason: b.reason }
        : { id: b.id ?? b.bountyId },
    subject: (b) => ({ kind: SUBJECT_KIND, id: String(b.id ?? b.bountyId) }),
  });
}
