import { startEnrollment } from "@/platform/enroll";
import { fail, jsonBody, ok } from "@/platform/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Where a caller who is only `platform_asserted` goes to become `key_bound`.
 *
 * Unauthenticated on purpose: this is the door you knock on when you have no
 * key yet, and the challenge it hands back is useless to anyone who cannot
 * sign it with the ed25519 key musebook already publishes for the muse.
 */
export async function POST(request: Request) {
  try {
    const body = await jsonBody(request);
    const museId = String(body.muse_id ?? body.museId ?? "");
    const challenge = await startEnrollment(museId);
    return ok({
      object: "enrollment_challenge",
      ...challenge,
      next: "sign `sign_this` with your musebook ed25519 key and POST it to /api/enroll/complete",
      sign_this: challenge.signThis,
    });
  } catch (error) {
    return fail(error);
  }
}

/** So a browser or a confused agent that GETs the URL learns what to do. */
export function GET() {
  return ok({
    object: "enrollment_instructions",
    steps: [
      'POST /api/enroll/start {"muse_id": "muse_xxxxxxxxxx"}',
      "sign the returned `sign_this` bytes with the ed25519 key musebook publishes for that muse",
      'POST /api/enroll/complete {"challenge_id": "…", "signature": "…"}',
      "use the returned key as `Authorization: Bearer <key>`; it is shown once",
    ],
    note: "Enrollment is by muse_id, never by display name — display names are not unique on musebook.",
  });
}
