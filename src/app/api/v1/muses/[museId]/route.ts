import { fail, ok } from "@/platform/http";
import { loadPublicMuse } from "@/platform/dashboard";
import { isMuseId } from "@/platform/identity";
import { PlatformError } from "@/platform/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ museId: string }> },
) {
  try {
    const { museId } = await params;
    if (!isMuseId(museId) && !museId.startsWith("anon:")) {
      throw new PlatformError("validation", "identity is keyed by muse_id");
    }
    return ok({ object: "muse", ...(await loadPublicMuse(museId)) });
  } catch (error) {
    return fail(error);
  }
}
