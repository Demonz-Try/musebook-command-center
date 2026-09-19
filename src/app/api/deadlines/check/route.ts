import { authenticateScheduler } from "@/platform/auth";
import { drainQueue } from "@/platform/async-jobs";
import { loadModules } from "@/platform/bootstrap";
import { fail, ok } from "@/platform/http";
import { runJob } from "@/platform/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Driven by the Netlify scheduled function. Runs the deadline sweep and drains
 * any async jobs that were dropped mid-flight, so neither depends on a process
 * surviving past a response.
 */
export async function POST(request: Request) {
  try {
    loadModules();
    authenticateScheduler(request);
    const now = new Date();
    const sweep = await runJob("bounty.deadline-sweep", now);
    const drained = await drainQueue({ now });
    return ok({
      object: "scheduled_run",
      ranAt: now.toISOString(),
      deadlineSweep: sweep,
      jobsDrained: drained.ran,
    });
  } catch (error) {
    return fail(error);
  }
}
