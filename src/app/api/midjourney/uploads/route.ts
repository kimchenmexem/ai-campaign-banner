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
  loadMidjourneyUploads,
  writeMidjourneyUploads,
} from "@/lib/midjourney/loadUploads";
import { refuseInProduction, requireRole } from "@/lib/auth/guard";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/auth/rateLimit";
import {
  UploadValidationError,
  validateImageUpload,
} from "@/lib/uploads/validateImageUpload";
import { getAssetStorage } from "@/lib/storage/AssetStorage";

// /api/midjourney/uploads
//   GET           → list current upload records (viewer)
//   POST (multipart) → validate, scan, decode, store via AssetStorage, append
//                      to the uploads index (editor)
//   POST (JSON)   → patch one upload's `approved` / `notes` fields (editor)
//   DELETE        → ?upload_id=...  remove the stored bytes + record (editor)
//
// File payload goes through validateImageUpload (size + MIME + magic-byte +
// sharp decode). Bytes are persisted via AssetStorage which is backed by
// Supabase Storage in production. Public direct URLs are only returned in
// local development; in production we hand back a signed URL.

const PatchSchema = z.object({
  upload_id: z.string().min(1),
  approved: z.boolean().optional(),
  notes: z.string().optional(),
});

const DeleteSchema = z.object({
  upload_id: z.string().min(1),
});

export async function GET(request: Request) {
  const auth = await requireRole(request, "viewer");
  if (auth instanceof NextResponse) return auth;
  const file = await loadMidjourneyUploads();
  return NextResponse.json({ ok: true, uploads: file.uploads });
}

export async function POST(request: Request) {
  // Both write paths go through editor+rate-limit.
  const auth = await requireRole(request, "editor");
  if (auth instanceof NextResponse) return auth;
  const limited = enforceRateLimit(request, RATE_LIMITS.upload, auth);
  if (limited) return limited;

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
    // Patching the index file is a dev-only operation today (JSON file).
    // Refuse in production unless the explicit local-fs flag is set.
    const blocked = refuseInProduction();
    if (blocked) return blocked;

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

  // Real upload validation: size, MIME, magic bytes, sharp decode, optional
  // content scanner. Strips EXIF by re-encoding.
  let validated;
  try {
    validated = await validateImageUpload(file);
  } catch (err) {
    if (err instanceof UploadValidationError) {
      return NextResponse.json(
        { ok: false, error: err.code, message: err.message },
        { status: err.status },
      );
    }
    throw err;
  }

  // Persist bytes via storage abstraction. In production this is Supabase
  // Storage; in dev it's the public/midjourney-uploads dir.
  const storage = getAssetStorage("uploads");
  const upload_id = `mj_${crypto.randomBytes(6).toString("hex")}`;
  const promptDir = sanitizePromptDir(meta.data.prompt_id);
  const storedKey = `${promptDir}/${upload_id}-${validated.safe_filename}`;
  const put = await storage.put(storedKey, validated.bytes, validated.mime);

  const record: MidjourneyUpload = {
    upload_id,
    prompt_id: meta.data.prompt_id,
    campaign_id: meta.data.campaign_id,
    ad_id: meta.data.ad_id,
    intended_use: meta.data.intended_use,
    context: meta.data.context,
    // local_path is now the storage key (provider-relative). The bytes are
    // never exposed at a public repo path in production.
    local_path: put.key,
    public_path: put.public_url,
    cloudinary_public_id: null,
    cloudinary_secure_url: put.signed_url,
    filename: validated.safe_filename,
    bytes: validated.size_bytes,
    approved: meta.data.approved ?? false,
    notes: meta.data.notes,
    source: "midjourney_manual_upload",
    created_at: new Date().toISOString(),
  };

  // The uploads index is a JSON file today (local dev). Writes to it are
  // dev-only — production should rely on a DB table backed by the same key.
  const indexBlocked = refuseInProduction();
  if (indexBlocked) {
    // Storage already accepted the bytes; surface a 202-ish state so the
    // operator can recover.
    return NextResponse.json(
      {
        ok: false,
        error: "uploads_index_unavailable_in_production",
        stored_key: put.key,
        signed_url: put.signed_url,
        message:
          "Production indexing is not implemented yet. Bytes were stored at the returned key.",
      },
      { status: 503 },
    );
  }
  const indexFile = await loadMidjourneyUploads();
  await writeMidjourneyUploads([record, ...indexFile.uploads]);
  return NextResponse.json({ ok: true, upload: record });
}

export async function DELETE(request: Request) {
  const auth = await requireRole(request, "editor");
  if (auth instanceof NextResponse) return auth;
  const limited = enforceRateLimit(request, RATE_LIMITS.write, auth);
  if (limited) return limited;

  const url = new URL(request.url);
  const parsed = DeleteSchema.safeParse({
    upload_id: url.searchParams.get("upload_id") ?? "",
  });
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
  // Delete via the storage abstraction. The local_path field on legacy
  // records may be a filesystem path; in that case we try a local unlink as
  // a courtesy. Either way the index update wins as source of truth.
  try {
    const storage = getAssetStorage("uploads");
    await storage.delete(target.local_path);
  } catch (err) {
    // Best-effort; the index entry is authoritative. Log and continue.
    console.warn("midjourney upload delete: storage delete failed", (err as Error).message);
  }
  const indexBlocked = refuseInProduction();
  if (indexBlocked) return indexBlocked;
  await writeMidjourneyUploads(
    file.uploads.filter((u) => u.upload_id !== parsed.data.upload_id),
  );
  return NextResponse.json({ ok: true, removed: target.upload_id });
}

const MetaSchema = z.object({
  prompt_id: z.string().min(1),
  intended_use: MidjourneyIntendedUseSchema,
  context: MidjourneyContextSchema,
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

function sanitizePromptDir(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "") || "_unsorted"
  );
}

// `path` import remains for tests/loaders elsewhere — keep tree-shaking
// honest by referencing it in a no-op.
void path;
