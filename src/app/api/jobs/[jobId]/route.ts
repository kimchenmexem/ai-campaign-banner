import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth/guard";
import { getJobRepository } from "@/lib/jobs/JobRepository";

export async function GET(
  request: Request,
  ctx: { params: Promise<{ jobId: string }> },
) {
  const auth = await requireRole(request, "viewer");
  if (auth instanceof NextResponse) return auth;
  const { jobId } = await ctx.params;
  const job = await getJobRepository().get(jobId);
  if (!job) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, job });
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ jobId: string }> },
) {
  // Canceling a job is admin-only — it abandons in-flight work.
  const auth = await requireRole(request, "admin");
  if (auth instanceof NextResponse) return auth;
  const { jobId } = await ctx.params;
  const repo = getJobRepository();
  const job = await repo.get(jobId);
  if (!job) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  if (job.status === "succeeded" || job.status === "failed" || job.status === "canceled") {
    return NextResponse.json(
      { ok: false, error: "cannot_cancel", status: job.status },
      { status: 409 },
    );
  }
  const cancelled = await repo.cancel(jobId);
  return NextResponse.json({ ok: true, job: cancelled });
}
