import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  MidjourneyAspectRatioSchema,
  MidjourneyContextSchema,
  MidjourneyIntendedUseSchema,
  type MidjourneyUpload,
} from "@/lib/schemas/midjourney.schema";
import {
  UPLOADS_PUBLIC_DIR,
  loadMidjourneyUploads,
  writeMidjourneyUploads,
} from "@/lib/midjourney/loadUploads";

// /api/midjourney/uploads
//   GET           → list current upload records
//   POST (multipart) → save the file under public/midjourney-uploads/<prompt_id>/
//                     and append to data/midjourney-uploads.generated.json
//   POST (JSON)   → patch one upload's `approved` / `notes` fields
//   DELETE        → ?upload_id=...  remove the local file + record
//
// Local-development tool. Writing to the repo's public/ dir is intentional —
// production deployments should swap the storage layer. No auth.

const ALLOWED_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp"]);

const PatchSchema = z.object({
  upload_id: z.string().min(1),
  approved: z.boolean().optional(),
  notes: z.string().optional(),
});

const DeleteSchema = z.object({
  upload_id: z.string().min(1),
});

export async function GET() {
  const file = await loadMidjourneyUploads();
  return NextResponse.json({ ok: true, uploads: file.uploads });
}

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";

  // ── JSON patch: approve / notes ──
  if (contentType.includes("application/json")) {
    const body = await request.json().catch(() => null);
    const parsed = PatchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "invalid_request", issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const file = await loadMidjourneyUploads();
    const idx = file.uploads.findIndex((u) => u.upload_id === parsed.data.upload_id);
    if (idx === -1) {
      return NextResponse.json(
        { ok: false, error: "upload_not_found", upload_id: parsed.data.upload_id },
        { status: 404 },
      );
    }
    const updated: MidjourneyUpload = {
      ...file.uploads[idx],
      ...(parsed.data.approved !== undefined ? { approved: parsed.data.approved } : {}),
      ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes } : {}),
    };
    const next = [...file.uploads];
    next[idx] = updated;
    await writeMidjourneyUploads(next);
    return NextResponse.json({ ok: true, upload: updated });
  }

  // ── Multipart upload: file + metadata ──
  const form = await request.formData().catch(() => null);
  if (!form) {
    return NextResponse.json(
      { ok: false, error: "invalid_form_data" },
      { status: 400 },
    );
  }
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json(
      { ok: false, error: "missing_file" },
      { status: 400 },
    );
  }

  const meta = parseFormMeta(form);
  if (!meta.success) {
    return NextResponse.json(
      { ok: false, error: "invalid_metadata", issues: meta.issues },
      { status: 400 },
    );
  }

  const ext = path.extname(file.name).slice(1).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return NextResponse.json(
      {
        ok: false,
        error: "unsupported_extension",
        hint: `Allowed: ${Array.from(ALLOWED_EXTENSIONS).join(", ")}`,
      },
      { status: 415 },
    );
  }

  const upload_id = `mj_${crypto.randomBytes(6).toString("hex")}`;
  const sanitized = sanitizeFilename(file.name);
  const promptDir = sanitizePromptDir(meta.data.prompt_id);
  const publicDir = path.join(process.cwd(), "public", UPLOADS_PUBLIC_DIR, promptDir);
  await fs.mkdir(publicDir, { recursive: true });
  const localFilename = `${upload_id}-${sanitized}`;
  const absPath = path.join(publicDir, localFilename);
  const localPath = path.relative(process.cwd(), absPath);
  const publicPath = `/${UPLOADS_PUBLIC_DIR}/${promptDir}/${localFilename}`;

  const arrayBuf = await file.arrayBuffer();
  await fs.writeFile(absPath, Buffer.from(arrayBuf));

  const record: MidjourneyUpload = {
    upload_id,
    prompt_id: meta.data.prompt_id,
    campaign_id: meta.data.campaign_id,
    ad_id: meta.data.ad_id,
    intended_use: meta.data.intended_use,
    context: meta.data.context,
    local_path: localPath,
    public_path: publicPath,
    cloudinary_public_id: null,
    cloudinary_secure_url: null,
    filename: file.name,
    bytes: file.size,
    approved: meta.data.approved ?? false,
    notes: meta.data.notes,
    source: "midjourney_manual_upload",
    created_at: new Date().toISOString(),
  };

  const indexFile = await loadMidjourneyUploads();
  await writeMidjourneyUploads([record, ...indexFile.uploads]);
  return NextResponse.json({ ok: true, upload: record });
}

export async function DELETE(request: Request) {
  const url = new URL(request.url);
  const parsed = DeleteSchema.safeParse({ upload_id: url.searchParams.get("upload_id") ?? "" });
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "invalid_request", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const file = await loadMidjourneyUploads();
  const target = file.uploads.find((u) => u.upload_id === parsed.data.upload_id);
  if (!target) {
    return NextResponse.json(
      { ok: false, error: "upload_not_found", upload_id: parsed.data.upload_id },
      { status: 404 },
    );
  }
  // Best-effort delete of the local file.
  try {
    const abs = path.resolve(process.cwd(), target.local_path);
    await fs.unlink(abs);
  } catch (err) {
    // OK to ignore — the index is the authoritative record.
    void err;
  }
  await writeMidjourneyUploads(
    file.uploads.filter((u) => u.upload_id !== parsed.data.upload_id),
  );
  return NextResponse.json({ ok: true, removed: target.upload_id });
}

const MetaSchema = z.object({
  prompt_id: z.string().min(1),
  intended_use: MidjourneyIntendedUseSchema,
  context: MidjourneyContextSchema,
  // Aspect ratio is informational; we still accept it from the form so the UI
  // can pre-fill it from the chosen prompt without a separate lookup.
  aspect_ratio: MidjourneyAspectRatioSchema.optional(),
  campaign_id: z.string().optional(),
  ad_id: z.string().optional(),
  approved: z.coerce.boolean().optional(),
  notes: z.string().optional(),
});

function parseFormMeta(form: FormData):
  | { success: true; data: z.infer<typeof MetaSchema> }
  | { success: false; issues: unknown } {
  const obj: Record<string, unknown> = {};
  for (const k of [
    "prompt_id",
    "intended_use",
    "context",
    "aspect_ratio",
    "campaign_id",
    "ad_id",
    "approved",
    "notes",
  ]) {
    const v = form.get(k);
    if (v != null && v !== "") obj[k] = typeof v === "string" ? v : v;
  }
  const parsed = MetaSchema.safeParse(obj);
  if (!parsed.success) return { success: false, issues: parsed.error.issues };
  return { success: true, data: parsed.data };
}

function sanitizeFilename(name: string): string {
  const dot = name.lastIndexOf(".");
  const stem = dot === -1 ? name : name.slice(0, dot);
  const ext = dot === -1 ? "" : name.slice(dot).toLowerCase();
  const cleanStem = stem
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return (cleanStem || "asset") + ext.replace(/[^a-z0-9.]/g, "");
}

function sanitizePromptDir(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "") || "_unsorted"
  );
}
