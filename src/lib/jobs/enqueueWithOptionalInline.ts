import "server-only";
import { getJobRepository } from "@/lib/jobs/JobRepository";
import { processJob } from "@/lib/jobs/processor";
import type { Job, JobType } from "@/lib/jobs/types";

// Shared enqueue helper used by every enqueue route. When `WORKER_INLINE=true`
// (default in dev, off in prod) the helper kicks off the work in the same
// process so a developer who hasn't started the worker still sees jobs run.
// In production, WORKER_INLINE must be unset so the dedicated worker process
// handles the work.

interface Args {
  type: JobType;
  campaign_id: string | null;
  created_by: string | null;
  input: unknown;
  idempotency_key?: string | null;
}

function workerInlineEnabled(): boolean {
  if (process.env.NODE_ENV === "production") {
    // Allow only when explicitly opted in; this is a footgun we don't want
    // to default on in production.
    return process.env.WORKER_INLINE === "true";
  }
  // Dev default: inline so the existing UI keeps working without a separate
  // worker terminal.
  return process.env.WORKER_INLINE !== "false";
}

export async function enqueueAndMaybeRunInline(args: Args): Promise<Job> {
  const repo = getJobRepository();
  const job = await repo.enqueue(args);

  if (!workerInlineEnabled()) return job;

  // Fire and forget. The HTTP response can return job_id immediately while
  // this runs in the background. We don't await — if the user wants to wait,
  // they GET /api/jobs/{id} and poll.
  (async () => {
    try {
      const claimed = await repo.markRunning(job.id);
      const result = await processJob(claimed);
      await repo.markSucceeded(claimed.id, result);
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      try {
        await repo.markFailed(job.id, msg);
      } catch {
        // swallow — already reported
      }
    }
  })();

  return job;
}
