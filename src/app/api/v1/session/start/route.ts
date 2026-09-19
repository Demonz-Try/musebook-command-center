import { jsonBody, fail, ok } from "@/platform/http";
import { requireMuseId } from "@/platform/session-http";
import { startPairing, type SessionScope } from "@/platform/session";
import { PlatformError } from "@/platform/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await jsonBody(request);
    const museId = requireMuseId(body.muse_id ?? body.museId);
    const scopeRaw = body.scope;
    const scope: SessionScope =
      scopeRaw === "elevated" ? "elevated" : scopeRaw === "read" || !scopeRaw
        ? "read"
        : (() => {
            throw new PlatformError("validation", 'scope must be "read" or "elevated"');
          })();
    const started = await startPairing({ museId, scope });
    return ok(
      {
        object: "pairing",
        status: "pending",
        ...started,
        agent: {
          instruction:
            "Sign `sign_this` with the musebook ed25519 private key for this muse_id, then POST /api/v1/session/complete. Never paste the private key into the browser.",
          complete: {
            method: "POST",
            path: "/api/v1/session/complete",
            body: { pairing_code: started.pairing_code, signature: "<base64url ed25519 signature>" },
          },
        },
      },
      201,
    );
  } catch (error) {
    return fail(error);
  }
}
