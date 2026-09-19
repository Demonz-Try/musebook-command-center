import { NextResponse } from "next/server";
import { fail } from "@/platform/http";
import { jsonBody } from "@/platform/http";
import {
  authenticateSession,
  clearSessionCookie,
  revokeAllSessions,
  revokeSession,
} from "@/platform/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const ctx = await authenticateSession(request);
    const body = await jsonBody(request).catch(() => ({} as Record<string, unknown>));
    if (typeof body.session_id === "string") {
      await revokeSession(ctx.actor.id, body.session_id);
    } else {
      await revokeAllSessions(ctx.actor.id);
    }
    const response = NextResponse.json({ object: "session", revoked: true });
    if (typeof body.session_id !== "string" || body.session_id === ctx.session.id) {
      response.headers.append("set-cookie", clearSessionCookie());
    }
    return response;
  } catch (error) {
    return fail(error);
  }
}
