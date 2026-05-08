#!/usr/bin/env tsx
/**
 * Print a summary of the Midjourney upload index + assignments.
 * Run with: `npm run midjourney:list-uploads`
 *
 * Surfaces:
 *   - total uploads, approved count, assigned count
 *   - per-intended_use counts
 *   - per-context counts
 *   - one row per upload with key fields
 *   - active assignments grouped by (format, target_element_role)
 *
 * Read-only. Does NOT call Midjourney.
 */
import { loadMidjourneyUploads } from "@/lib/midjourney/loadUploads";
import { loadMidjourneyAssignments } from "@/lib/midjourney/loadAssignments";
import type {
  MidjourneyAssignment,
  MidjourneyContext,
  MidjourneyIntendedUse,
} from "@/lib/schemas/midjourney.schema";

async function main() {
  const uploadsFile = await loadMidjourneyUploads();
  const assignmentsFile = await loadMidjourneyAssignments();
  const uploads = uploadsFile.uploads;
  const assignments = assignmentsFile.assignments;

  const approvedCount = uploads.filter((u) => u.approved).length;
  const assignedUploadIds = new Set(
    assignments.filter((a) => a.active).map((a) => a.upload_id),
  );

  const byIntended = new Map<MidjourneyIntendedUse, number>();
  const byContext = new Map<MidjourneyContext, number>();
  for (const u of uploads) {
    byIntended.set(u.intended_use, (byIntended.get(u.intended_use) ?? 0) + 1);
    byContext.set(u.context, (byContext.get(u.context) ?? 0) + 1);
  }

  console.log("Midjourney uploads + assignments");
  console.log("─".repeat(72));
  console.log(`  total uploads:    ${uploads.length}`);
  console.log(`  approved:         ${approvedCount}`);
  console.log(`  with assignment:  ${assignedUploadIds.size}`);
  console.log(`  total assignments:${assignments.length} (${assignments.filter((a) => a.active).length} active)`);
  console.log("");

  if (byIntended.size > 0) {
    console.log("By intended_use");
    console.log("─".repeat(72));
    for (const [k, v] of byIntended) console.log(`  ${k.padEnd(14)} ${v}`);
    console.log("");
  }
  if (byContext.size > 0) {
    console.log("By context");
    console.log("─".repeat(72));
    for (const [k, v] of byContext) console.log(`  ${k.padEnd(20)} ${v}`);
    console.log("");
  }

  if (uploads.length > 0) {
    console.log("Uploads");
    console.log("─".repeat(72));
    for (const u of uploads) {
      const tag = u.approved ? "✓" : "·";
      const assigned = assignedUploadIds.has(u.upload_id) ? " [assigned]" : "";
      console.log(
        `  ${tag} ${u.upload_id} · ${u.intended_use.padEnd(13)} · ${u.context.padEnd(18)} · ${u.filename}${assigned}`,
      );
    }
    console.log("");
  }

  if (assignments.length > 0) {
    console.log("Active assignments by slot");
    console.log("─".repeat(72));
    const grouped = groupBySlot(assignments.filter((a) => a.active));
    for (const [slot, list] of grouped) {
      console.log(`  ${slot}`);
      for (const a of list) {
        console.log(
          `    → ${a.assignment_id} · upload=${a.upload_id} · priority=${a.priority}`,
        );
      }
    }
    console.log("");
  }

  if (uploads.length === 0) {
    console.log("Tip: open /midjourney in the dev server to upload Midjourney outputs.");
  } else if (approvedCount === 0) {
    console.log("Tip: approve at least one upload (toggle on /midjourney) so it can be assigned.");
  } else if (assignedUploadIds.size === 0) {
    console.log(
      "Tip: open /midjourney and click 'Assign' on an approved upload to bind it to a (format, role) slot.",
    );
  } else {
    console.log("Run `npm run preview:demo` to apply assignments to the demo manifest.");
  }
}

function groupBySlot(assignments: MidjourneyAssignment[]): Map<string, MidjourneyAssignment[]> {
  const map = new Map<string, MidjourneyAssignment[]>();
  for (const a of assignments) {
    const key = `${a.format ?? "all"} / ${a.target_element_role}`;
    const list = map.get(key) ?? [];
    list.push(a);
    map.set(key, list);
  }
  return map;
}

main().catch((err) => {
  console.error("midjourney:list-uploads failed:", (err as Error).message);
  process.exit(1);
});
