/* eslint-disable no-console */
// ─────────────────────────────────────────────────────────────────────────────
// Standalone job worker.
//
// Usage:
//   npm run worker            — runs forever, polling every 2 seconds
//   npm run worker -- --once  — claim one job, run it, exit
//
// Production: deploy this as a separate process (Cloud Run job, Fly machine,
// systemd service, etc.) using the same env vars as the Next app. The Supabase
// JobRepository uses `claim_next_queued_job` (SKIP LOCKED) so you can scale
// horizontally.
// ─────────────────────────────────────────────────────────────────────────────
import { getJobRepository } from "@/lib/jobs/JobRepository";
import { processJob } from "@/lib/jobs/processor";
import type { JobType } from "@/lib/jobs/types";

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 2000);
const TYPES: JobType[] = ["render", "variants", "export"];

async function tick(): Promise<boolean> {
  const repo = getJobRepository();
  const job = await repo.claimNextQueued(TYPES);
  if (!job) return false;
  console.log(`[worker] picked up ${job.id} (${job.type}, campaign=${job.campaign_id ?? "n/a"})`);
  try {
    const result = await processJob(job);
    await repo.markSucceeded(job.id, result);
    console.log(`[worker] succeeded ${job.id}`);
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    console.error(`[worker] FAILED ${job.id}: ${msg}`);
    await repo.markFailed(job.id, msg);
  }
  return true;
}

async function main() {
  const once = process.argv.includes("--once");
  console.log(`[worker] starting (driver=${getJobRepository().driver}, once=${once})`);
  if (once) {
    const ran = await tick();
    process.exit(ran ? 0 : 0);
  }
  // Continuous polling. Sleeps POLL_INTERVAL_MS between empty cycles.
  for (;;) {
    const ran = await tick();
    if (!ran) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }
}

main().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});
