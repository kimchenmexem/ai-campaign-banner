import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { z } from "zod";
import {
  MidjourneyAssignmentFormatSchema,
  MidjourneyAssignmentTargetRoleSchema,
  type MidjourneyAssignment,
} from "@/lib/schemas/midjourney.schema";
import {
  loadMidjourneyAssignments,
  writeMidjourneyAssignments,
} from "@/lib/midjourney/loadAssignments";
import { loadMidjourneyUploads } from "@/lib/midjourney/loadUploads";
import { refuseInProduction, requireRole } from "@/lib/auth/guard";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/auth/rateLimit";

// /api/midjourney/assignments
//   GET           → list current assignments
//   POST (JSON)   → create / replace the assignment for one (format, role) slot.
//                   Only approved uploads may be assigned. Existing active
//                   assignments for the same slot are auto-deactivated so the
//                   new one wins.
//   POST { assignment_id, active: false } → toggle / deactivate an existing
//                   assignment by id.
//   DELETE        → ?assignment_id=...  remove an assignment
//
// Local-development tool. No auth.

const CreateBodySchema = z.object({
  upload_id: z.string().min(1),
  format: MidjourneyAssignmentFormatSchema,
  target_element_role: MidjourneyAssignmentTargetRoleSchema,
  campaign_id: z.string().optional(),
  ad_id: z.string().optional(),
  priority: z.number().int().optional(),
  active: z.boolean().optional(),
});

const PatchBodySchema = z.object({
  assignment_id: z.string().min(1),
  active: z.boolean().optional(),
  priority: z.number().int().optional(),
});

const DeleteSchema = z.object({
  assignment_id: z.string().min(1),
});

export async function GET(request: Request) {
  const auth = await requireRole(request, "viewer");
  if (auth instanceof NextResponse) return auth;
  const file = await loadMidjourneyAssignments();
  return NextResponse.json({ ok: true, assignments: file.assignments });
}

export async function POST(request: Request) {
  const blocked = refuseInProduction();
  if (blocked) return blocked;
  const auth = await requireRole(request, "editor");
  if (auth instanceof NextResponse) return auth;
  const limited = enforceRateLimit(request, RATE_LIMITS.write, auth);
  if (limited) return limited;

  const json = await request.json().catch(() => null);
  if (!json) {
    return NextResponse.json(
      { ok: false, error: "invalid_json" },
      { status: 400 },
    );
  }

  // Branch on shape: a body with `assignment_id` is a patch; otherwise create.
  if (typeof (json as { assignment_id?: unknown }).assignment_id === "string") {
    const parsed = PatchBodySchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "invalid_request", issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const file = await loadMidjourneyAssignments();
    const idx = file.assignments.findIndex(
      (a) => a.assignment_id === parsed.data.assignment_id,
    );
    if (idx === -1) {
      return NextResponse.json(
        { ok: false, error: "assignment_not_found" },
        { status: 404 },
      );
    }
    const updated: MidjourneyAssignment = {
      ...file.assignments[idx],
      ...(parsed.data.active !== undefined ? { active: parsed.data.active } : {}),
      ...(parsed.data.priority !== undefined
        ? { priority: parsed.data.priority }
        : {}),
    };
    const next = [...file.assignments];
    next[idx] = updated;
    await writeMidjourneyAssignments(next);
    return NextResponse.json({ ok: true, assignment: updated });
  }

  const parsed = CreateBodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "invalid_request", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  // Only approved uploads may be assigned.
  const uploadsFile = await loadMidjourneyUploads();
  const upload = uploadsFile.uploads.find(
    (u) => u.upload_id === parsed.data.upload_id,
  );
  if (!upload) {
    return NextResponse.json(
      { ok: false, error: "upload_not_found", upload_id: parsed.data.upload_id },
      { status: 404 },
    );
  }
  if (!upload.approved) {
    return NextResponse.json(
      {
        ok: false,
        error: "upload_not_approved",
        hint: "Approve the upload first (toggle the Approved checkbox on /midjourney).",
      },
      { status: 409 },
    );
  }

  const assignmentsFile = await loadMidjourneyAssignments();
  // Auto-deactivate any other active assignment for the same (format, role)
  // so the new one is the winner.
  const others = assignmentsFile.assignments.map((a) => {
    if (
      a.active &&
      a.format === parsed.data.format &&
      a.target_element_role === parsed.data.target_element_role
    ) {
      return { ...a, active: false };
    }
    return a;
  });

  const newAssignment: MidjourneyAssignment = {
    assignment_id: `mja_${crypto.randomBytes(6).toString("hex")}`,
    upload_id: parsed.data.upload_id,
    campaign_id: parsed.data.campaign_id,
    ad_id: parsed.data.ad_id,
    format: parsed.data.format,
    target_element_role: parsed.data.target_element_role,
    priority: parsed.data.priority ?? 0,
    active: parsed.data.active ?? true,
    created_at: new Date().toISOString(),
  };
  await writeMidjourneyAssignments([newAssignment, ...others]);
  return NextResponse.json({ ok: true, assignment: newAssignment });
}

export async function DELETE(request: Request) {
  const blocked = refuseInProduction();
  if (blocked) return blocked;
  const auth = await requireRole(request, "editor");
  if (auth instanceof NextResponse) return auth;
  const limited = enforceRateLimit(request, RATE_LIMITS.write, auth);
  if (limited) return limited;

  const url = new URL(request.url);
  const parsed = DeleteSchema.safeParse({
    assignment_id: url.searchParams.get("assignment_id") ?? "",
  });
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "invalid_request", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const file = await loadMidjourneyAssignments();
  const target = file.assignments.find(
    (a) => a.assignment_id === parsed.data.assignment_id,
  );
  if (!target) {
    return NextResponse.json(
      { ok: false, error: "assignment_not_found" },
      { status: 404 },
    );
  }
  await writeMidjourneyAssignments(
    file.assignments.filter((a) => a.assignment_id !== parsed.data.assignment_id),
  );
  return NextResponse.json({ ok: true, removed: target.assignment_id });
}
