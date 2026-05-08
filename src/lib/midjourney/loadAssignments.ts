import { promises as fs } from "node:fs";
import path from "node:path";
import {
  MidjourneyAssignmentFileSchema,
  type MidjourneyAssignment,
  type MidjourneyAssignmentFile,
  type MidjourneyAssignmentFormat,
  type MidjourneyAssignmentTargetRole,
} from "@/lib/schemas/midjourney.schema";

// ─────────────────────────────────────────────────────────────────────────────
// Load + write helpers for `data/midjourney-assignments.generated.json`.
// Single-writer assumption (the API route is the only writer).
// ─────────────────────────────────────────────────────────────────────────────

export const ASSIGNMENTS_INDEX_PATH = path.join(
  process.cwd(),
  "data",
  "midjourney-assignments.generated.json",
);

export async function loadMidjourneyAssignments(
  filePath: string = ASSIGNMENTS_INDEX_PATH,
): Promise<MidjourneyAssignmentFile> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return MidjourneyAssignmentFileSchema.parse(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { generated_at: new Date().toISOString(), assignments: [] };
    }
    throw err;
  }
}

export async function writeMidjourneyAssignments(
  assignments: MidjourneyAssignment[],
  filePath: string = ASSIGNMENTS_INDEX_PATH,
): Promise<void> {
  const file: MidjourneyAssignmentFile = MidjourneyAssignmentFileSchema.parse({
    generated_at: new Date().toISOString(),
    assignments,
  });
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(file, null, 2) + "\n", "utf8");
}

/**
 * Find the active assignment that should drive a given (format, target role)
 * slot. Format-specific assignments win over format=null assignments. Within
 * the same precedence tier, higher `priority` wins; ties broken by most-
 * recent `created_at`.
 */
export function findAssignmentForSlot(
  assignments: MidjourneyAssignment[],
  format: MidjourneyAssignmentFormat,
  target: MidjourneyAssignmentTargetRole,
): MidjourneyAssignment | null {
  const candidates = assignments.filter(
    (a) =>
      a.active &&
      a.target_element_role === target &&
      (a.format === format || a.format === null),
  );
  if (candidates.length === 0) return null;

  // Format-specific beats null-format. Then priority desc, then created_at desc.
  candidates.sort((a, b) => {
    const aFmtRank = a.format === format ? 1 : 0;
    const bFmtRank = b.format === format ? 1 : 0;
    if (aFmtRank !== bFmtRank) return bFmtRank - aFmtRank;
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.created_at < b.created_at ? 1 : -1;
  });
  return candidates[0];
}

/**
 * Index assignments by upload_id for the upload UI's "current assignments"
 * list.
 */
export function groupAssignmentsByUploadId(
  assignments: MidjourneyAssignment[],
): Map<string, MidjourneyAssignment[]> {
  const map = new Map<string, MidjourneyAssignment[]>();
  for (const a of assignments) {
    const list = map.get(a.upload_id) ?? [];
    list.push(a);
    map.set(a.upload_id, list);
  }
  return map;
}
