import { getJob } from "@/platform/async-jobs";
import { readEndpoint } from "@/platform/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Poll target for every 202. Terminal states are `succeeded` and `failed`. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return readEndpoint(request, async ({ actor }) => {
    const job = await getJob(id, actor);
    return {
      object: "job",
      id: job.id,
      kind: job.kind,
      status: job.status,
      muse: job.muse,
      attempts: job.attempts,
      result: job.result ?? null,
      error: job.errorCode
        ? { code: job.errorCode, message: job.errorMessage }
        : null,
      createdAt: job.createdAt.toISOString(),
      startedAt: job.startedAt?.toISOString() ?? null,
      finishedAt: job.finishedAt?.toISOString() ?? null,
    };
  });
}
