import { mintGrant, type Capability, type CapabilityGrant } from "./capabilities";
import { PlatformError } from "./errors";
import { systemActor, type Actor } from "./identity";
import type { Trust } from "./commands/types";

export interface JobContext {
  actor: Actor;
  capabilities: CapabilityGrant;
  now: Date;
}

export interface JobDefinition {
  /** Globally unique: "bounty.deadline-sweep". */
  name: string;
  moduleId: string;
  trust: Trust;
  summary: string;
  /** Cron or Netlify shorthand, e.g. "@hourly". Documentation for the schedule
   *  configured in netlify.toml — the platform does not run its own timer. */
  schedule: string;
  capabilities: Capability[];
  run: (ctx: JobContext) => Promise<unknown>;
}

interface JobEntry {
  job: JobDefinition;
  grant: CapabilityGrant;
}

const jobs = new Map<string, JobEntry>();

export function registerJob(job: JobDefinition): void {
  if (jobs.has(job.name)) {
    throw new PlatformError("validation", `job "${job.name}" is already registered`);
  }
  const grant = mintGrant(`job:${job.name}`, job.capabilities, job.trust);
  jobs.set(job.name, { job, grant });
}

export function resetJobs(): void {
  jobs.clear();
}

export function listJobs(): JobDefinition[] {
  return [...jobs.values()].map((e) => e.job);
}

export async function runJob(name: string, now = new Date()): Promise<unknown> {
  const entry = jobs.get(name);
  if (!entry) throw new PlatformError("not_found", `no job named "${name}"`);
  return entry.job.run({
    actor: systemActor(name.replace(/[^a-z0-9.-]/gi, "-").toLowerCase()),
    capabilities: entry.grant,
    now,
  });
}

export async function runAllJobs(
  now = new Date(),
): Promise<{ job: string; ok: boolean; result?: unknown; error?: string }[]> {
  const results = [];
  for (const { job } of jobs.values()) {
    try {
      results.push({ job: job.name, ok: true, result: await runJob(job.name, now) });
    } catch (error) {
      results.push({ job: job.name, ok: false, error: (error as Error).message });
    }
  }
  return results;
}
