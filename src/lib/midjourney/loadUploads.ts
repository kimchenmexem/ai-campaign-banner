import { promises as fs } from "node:fs";
import path from "node:path";
import {
  MidjourneyUploadFileSchema,
  type MidjourneyUpload,
  type MidjourneyUploadFile,
} from "@/lib/schemas/midjourney.schema";

// ─────────────────────────────────────────────────────────────────────────────
// Load + write helpers for `data/midjourney-uploads.generated.json`.
//
// Single-writer assumption (this is a local dev tool). The upload API route
// is the only writer; pages and lib code only read.
// ─────────────────────────────────────────────────────────────────────────────

export const UPLOADS_INDEX_PATH = path.join(
  process.cwd(),
  "data",
  "midjourney-uploads.generated.json",
);

export const UPLOADS_PUBLIC_DIR = "midjourney-uploads"; // under /public

export async function loadMidjourneyUploads(
  filePath: string = UPLOADS_INDEX_PATH,
): Promise<MidjourneyUploadFile> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return MidjourneyUploadFileSchema.parse(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { generated_at: new Date().toISOString(), uploads: [] };
    }
    throw err;
  }
}

export async function writeMidjourneyUploads(
  uploads: MidjourneyUpload[],
  filePath: string = UPLOADS_INDEX_PATH,
): Promise<void> {
  const file: MidjourneyUploadFile = MidjourneyUploadFileSchema.parse({
    generated_at: new Date().toISOString(),
    uploads,
  });
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(file, null, 2) + "\n", "utf8");
}

/**
 * Convenience: filter to approved uploads only, optionally narrowed by
 * intended_use and/or context.
 */
export interface ApprovedUploadFilter {
  intended_use?: MidjourneyUpload["intended_use"];
  context?: MidjourneyUpload["context"];
}

export function filterApproved(
  uploads: MidjourneyUpload[],
  f: ApprovedUploadFilter = {},
): MidjourneyUpload[] {
  return uploads.filter((u) => {
    if (!u.approved) return false;
    if (f.intended_use && u.intended_use !== f.intended_use) return false;
    if (f.context && u.context !== f.context) return false;
    return true;
  });
}
