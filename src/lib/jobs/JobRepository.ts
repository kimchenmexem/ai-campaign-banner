import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { JobSchema, type Job, type JobStatus, type JobType } from "@/lib/jobs/types";

// ─────────────────────────────────────────────────────────────────────────────
// JobRepository — enqueue, claim, update, list, get.
//
//   - LocalJobRepository    → backed by data/jobs.generated.json. Suitable
//                              for local dev. NOT safe under multi-process
//                              concurrency; the worker script holds a single
//                              event loop and polls the file.
//   - SupabaseJobRepository → backed by the `jobs` table. Concurrency-safe:
//                              claimNextQueued() uses Postgres SKIP LOCKED via
//                              a stored procedure (see migrations).
//
// Production fails closed if Supabase env is missing.
// ─────────────────────────────────────────────────────────────────────────────

export interface EnqueueInput {
  type: JobType;
  campaign_id: string | null;
  created_by: string | null;
  input: unknown;
  // Idempotency: if a job with the same key already exists for this campaign,
  // returns it instead of creating a new one.
  idempotency_key?: string | null;
}

export interface JobRepository {
  readonly driver: "local" | "supabase";
  enqueue(input: EnqueueInput): Promise<Job>;
  get(jobId: string): Promise<Job | null>;
  list(filter?: { campaign_id?: string; status?: JobStatus; limit?: number }): Promise<Job[]>;
  claimNextQueued(types: JobType[]): Promise<Job | null>;
  markRunning(jobId: string): Promise<Job>;
  updateProgress(jobId: string, progress: number): Promise<void>;
  markSucceeded(jobId: string, result: unknown): Promise<Job>;
  markFailed(jobId: string, error: string): Promise<Job>;
  cancel(jobId: string): Promise<Job>;
}

function newJobId(): string {
  return `job_${crypto.randomBytes(8).toString("hex")}`;
}

// ─── Local FS implementation (dev only) ─────────────────────────────────────
class LocalJobRepository implements JobRepository {
  readonly driver = "local" as const;
  private readonly file: string;

  constructor(cwd: string = process.cwd()) {
    this.file = path.join(cwd, "data", "jobs.generated.json");
  }

  private async readAll(): Promise<Job[]> {
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as { jobs?: unknown };
      if (!parsed || !Array.isArray(parsed.jobs)) return [];
      const out: Job[] = [];
      for (const j of parsed.jobs) {
        const r = JobSchema.safeParse(j);
        if (r.success) out.push(r.data);
      }
      return out;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  private async writeAll(jobs: Job[]): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp.${Date.now()}.${process.pid}`;
    await fs.writeFile(
      tmp,
      JSON.stringify({ generated_at: new Date().toISOString(), jobs }, null, 2) + "\n",
      "utf8",
    );
    await fs.rename(tmp, this.file);
  }

  async enqueue(input: EnqueueInput): Promise<Job> {
    const all = await this.readAll();
    if (input.idempotency_key) {
      const existing = all.find(
        (j) =>
          j.idempotency_key === input.idempotency_key &&
          j.campaign_id === input.campaign_id &&
          j.type === input.type &&
          j.status !== "canceled" &&
          j.status !== "failed",
      );
      if (existing) return existing;
    }
    const now = new Date().toISOString();
    const job: Job = JobSchema.parse({
      id: newJobId(),
      type: input.type,
      campaign_id: input.campaign_id,
      created_by: input.created_by,
      status: "queued" as JobStatus,
      progress: 0,
      input: input.input,
      result: null,
      error: null,
      idempotency_key: input.idempotency_key ?? null,
      created_at: now,
      updated_at: now,
      started_at: null,
      finished_at: null,
    });
    await this.writeAll([job, ...all]);
    return job;
  }

  async get(id: string): Promise<Job | null> {
    const all = await this.readAll();
    return all.find((j) => j.id === id) ?? null;
  }

  async list(filter: { campaign_id?: string; status?: JobStatus; limit?: number } = {}): Promise<Job[]> {
    const all = await this.readAll();
    const filtered = all.filter((j) => {
      if (filter.campaign_id && j.campaign_id !== filter.campaign_id) return false;
      if (filter.status && j.status !== filter.status) return false;
      return true;
    });
    return filtered.slice(0, filter.limit ?? 50);
  }

  async claimNextQueued(types: JobType[]): Promise<Job | null> {
    const all = await this.readAll();
    const idx = all.findIndex(
      (j) => j.status === "queued" && types.includes(j.type),
    );
    if (idx < 0) return null;
    const now = new Date().toISOString();
    const claimed: Job = {
      ...all[idx],
      status: "running",
      started_at: now,
      updated_at: now,
    };
    const next = [...all];
    next[idx] = claimed;
    await this.writeAll(next);
    return claimed;
  }

  async markRunning(id: string): Promise<Job> {
    return this.patch(id, { status: "running", started_at: new Date().toISOString() });
  }
  async updateProgress(id: string, progress: number): Promise<void> {
    await this.patch(id, { progress });
  }
  async markSucceeded(id: string, result: unknown): Promise<Job> {
    return this.patch(id, {
      status: "succeeded",
      progress: 1,
      result,
      finished_at: new Date().toISOString(),
    });
  }
  async markFailed(id: string, error: string): Promise<Job> {
    return this.patch(id, {
      status: "failed",
      error,
      finished_at: new Date().toISOString(),
    });
  }
  async cancel(id: string): Promise<Job> {
    return this.patch(id, {
      status: "canceled",
      finished_at: new Date().toISOString(),
    });
  }

  private async patch(id: string, fields: Partial<Job>): Promise<Job> {
    const all = await this.readAll();
    const idx = all.findIndex((j) => j.id === id);
    if (idx < 0) throw new Error(`job ${id} not found`);
    const next: Job = {
      ...all[idx],
      ...fields,
      updated_at: new Date().toISOString(),
    };
    const list = [...all];
    list[idx] = next;
    await this.writeAll(list);
    return next;
  }
}

// ─── Supabase implementation ─────────────────────────────────────────────────
class SupabaseJobRepository implements JobRepository {
  readonly driver = "supabase" as const;
  private client: ReturnType<typeof createClient>;

  constructor(url: string, key: string) {
    this.client = createClient(url, key, { auth: { persistSession: false } });
  }

  async enqueue(input: EnqueueInput): Promise<Job> {
    if (input.idempotency_key) {
      const { data } = await this.client
        .from("jobs")
        .select("*")
        .eq("idempotency_key", input.idempotency_key)
        .eq("type", input.type)
        .eq("campaign_id", input.campaign_id ?? "")
        .not("status", "in", "(canceled,failed)")
        .maybeSingle();
      if (data) return JobSchema.parse(data);
    }
    const id = newJobId();
    const now = new Date().toISOString();
    const row = {
      id,
      type: input.type,
      campaign_id: input.campaign_id,
      created_by: input.created_by,
      status: "queued" as JobStatus,
      progress: 0,
      input: input.input,
      result: null,
      error: null,
      idempotency_key: input.idempotency_key ?? null,
      created_at: now,
      updated_at: now,
      started_at: null,
      finished_at: null,
    };
    const { data, error } = await this.client
      .from("jobs")
      .insert(row as never)
      .select("*")
      .single();
    if (error) throw new Error(`enqueue failed: ${error.message}`);
    return JobSchema.parse(data);
  }

  async get(id: string): Promise<Job | null> {
    const { data, error } = await this.client
      .from("jobs")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(`get job failed: ${error.message}`);
    return data ? JobSchema.parse(data) : null;
  }

  async list(filter: { campaign_id?: string; status?: JobStatus; limit?: number } = {}): Promise<Job[]> {
    let q = this.client.from("jobs").select("*").order("created_at", { ascending: false });
    if (filter.campaign_id) q = q.eq("campaign_id", filter.campaign_id);
    if (filter.status) q = q.eq("status", filter.status);
    q = q.limit(filter.limit ?? 50);
    const { data, error } = await q;
    if (error) throw new Error(`list jobs failed: ${error.message}`);
    const out: Job[] = [];
    for (const r of (data ?? []) as unknown[]) {
      const p = JobSchema.safeParse(r);
      if (p.success) out.push(p.data);
    }
    return out;
  }

  async claimNextQueued(types: JobType[]): Promise<Job | null> {
    // Postgres-side claim via a stored procedure. The procedure uses
    // SELECT ... FOR UPDATE SKIP LOCKED so multiple workers don't claim
    // the same row. See migrations/0002_jobs.sql.
    const { data, error } = await this.client.rpc(
      "claim_next_queued_job",
      { p_types: types } as never,
    );
    if (error) throw new Error(`claim failed: ${error.message}`);
    if (!data) return null;
    return JobSchema.parse(Array.isArray(data) ? data[0] : data);
  }

  async markRunning(id: string): Promise<Job> {
    return this.patch(id, { status: "running", started_at: new Date().toISOString() });
  }
  async updateProgress(id: string, progress: number): Promise<void> {
    await this.patch(id, { progress });
  }
  async markSucceeded(id: string, result: unknown): Promise<Job> {
    return this.patch(id, {
      status: "succeeded",
      progress: 1,
      result,
      finished_at: new Date().toISOString(),
    });
  }
  async markFailed(id: string, error: string): Promise<Job> {
    return this.patch(id, {
      status: "failed",
      error,
      finished_at: new Date().toISOString(),
    });
  }
  async cancel(id: string): Promise<Job> {
    return this.patch(id, {
      status: "canceled",
      finished_at: new Date().toISOString(),
    });
  }

  private async patch(id: string, fields: Partial<Job>): Promise<Job> {
    const { data, error } = await this.client
      .from("jobs")
      .update({ ...fields, updated_at: new Date().toISOString() } as never)
      .eq("id", id)
      .select("*")
      .single();
    if (error) throw new Error(`patch job failed: ${error.message}`);
    return JobSchema.parse(data);
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────
export function getJobRepository(): JobRepository {
  const driver = (process.env.JOB_REPO_DRIVER ?? process.env.CAMPAIGN_REPO_DRIVER ?? "").toLowerCase();
  const isProd = process.env.NODE_ENV === "production";

  if (driver === "supabase" || (isProd && driver !== "local")) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error(
        "JobRepository: Supabase driver requires NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.",
      );
    }
    return new SupabaseJobRepository(url, key);
  }

  if (isProd && process.env.ALLOW_LOCAL_FS_WRITES !== "true") {
    throw new Error(
      "JobRepository: refusing local-fs driver in production. Set JOB_REPO_DRIVER=supabase.",
    );
  }
  return new LocalJobRepository();
}
