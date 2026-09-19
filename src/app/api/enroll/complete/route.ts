import { completeEnrollment } from "@/platform/enroll";
import { fail, jsonBody, ok } from "@/platform/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Exchanges a signed challenge for the one kind of key that can move value.
 *
 * No idempotency key: the challenge is the idempotency key. It is burned before
 * the API key is minted, so a replayed signature gets `enrollment_failed`
 * rather than a second key.
 */
export async function POST(request: Request) {
  try {
    const body = await jsonBody(request);
    const issued = await completeEnrollment({
      challengeId: String(body.challenge_id ?? body.challengeId ?? ""),
      signature: String(body.signature ?? ""),
      label: typeof body.label === "string" ? body.label : undefined,
    });

    return ok({
      object: "api_key",
      id: issued.id,
      muse: issued.muse,
      label: issued.label,
      prefix: issued.prefix,
      assurance: issued.assurance,
      bound_via: issued.boundVia,
      key: issued.key,
      note: "This is the only time the key is shown. Send it as `Authorization: Bearer <key>`.",
    });
  } catch (error) {
    return fail(error);
  }
}
