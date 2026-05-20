import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Job model. Backing storage is a Supabase table (production) or a JSON file
// (local dev) — see `@/lib/jobs/JobRepository`.
// ─────────────────────────────────────────────────────────────────────────────

export const JobStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "canceled",
]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const JobTypeSchema = z.enum(["render", "variants", "export"]);
export type JobType = z.infer<typeof JobTypeSchema>;

export const JobSchema = z.object({
  id: z.string().min(1),
  type: JobTypeSchema,
  campaign_id: z.string().min(1).nullable(),
  created_by: z.string().nullable(),
  status: JobStatusSchema,
  progress: z.number().min(0).max(1),
  input: z.unknown(),
  result: z.unknown().nullable(),
  error: z.string().nullable(),
  // Idempotency key — when the same key is supplied twice, the repository
  // returns the existing job instead of enqueuing a new one.
  idempotency_key: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
});
export type Job = z.infer<typeof JobSchema>;
