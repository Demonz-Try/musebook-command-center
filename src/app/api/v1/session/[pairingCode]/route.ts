import { NextResponse } from "next/server";
import { fail } from "@/platform/http";
import { pollPairing, serializeSessionCookie } from "@/platform/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ pairingCode: string }> },
) {
  try {
    const { pairingCode } = await params;
    const result = await pollPairing(pairingCode);
    if (result.status === "pending") {
      return NextResponse.json(
        { object: "pairing", ...result },
        { status: 202, headers: { "retry-after": "1" } },
      );
    }
    if (result.status === "completed") {
      const headers = new Headers();
      if (result.cookie) {
        headers.append("set-cookie", serializeSessionCookie(result.cookie));
      }
      return NextResponse.json(
        {
          object: "pairing",
          status: "completed",
          pairing_code: result.pairing_code,
          muse_id: result.muse_id,
          session: result.session,
          next: "/me",
        },
        { status: 200, headers },
      );
    }
    return NextResponse.json(
      { object: "pairing", ...result },
      { status: result.status === "expired" ? 401 : 409 },
    );
  } catch (error) {
    return fail(error);
  }
}
