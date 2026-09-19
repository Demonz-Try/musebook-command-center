import { jsonBody, fail, ok } from "@/platform/http";
import { completePairing } from "@/platform/session";
import { PlatformError } from "@/platform/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await jsonBody(request);
    const pairingCode =
      typeof body.pairing_code === "string"
        ? body.pairing_code
        : typeof body.pairingCode === "string"
          ? body.pairingCode
          : "";
    const signature = typeof body.signature === "string" ? body.signature : "";
    if (!pairingCode) {
      throw new PlatformError("validation", "pairing_code is required");
    }
    const result = await completePairing({
      pairingCode,
      signature,
      userAgent: request.headers.get("user-agent") ?? undefined,
    });
    return ok({
      object: "pairing",
      status: "completed",
      muse_id: result.muse_id,
      session_id: result.session_id,
      scope: result.scope,
      assurance: "key_bound",
      poll: `/api/v1/session/${pairingCode.trim().toUpperCase()}`,
      note: "The browser poll receives the session cookie. This response does not.",
    });
  } catch (error) {
    return fail(error);
  }
}
