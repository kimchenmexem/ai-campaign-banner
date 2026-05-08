import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  getBannerbearTemplate,
  type BannerbearTemplateResponse,
} from "@/lib/bannerbear/client";
import {
  getTemplateMap,
  REQUIRED_BANNERBEAR_LAYERS,
  OPTIONAL_BANNERBEAR_LAYERS,
  type SupportedFormat,
} from "@/lib/bannerbear/templateMapping";
import {
  BannerbearTemplateSnapshotSchema,
  type BannerbearTemplateSnapshot,
} from "@/lib/schemas/bannerbear.schema";

// ─────────────────────────────────────────────────────────────────────────────
// Sync Bannerbear template metadata into a local snapshot file.
//
// What we cache:
//   - template_uid + name + width + height
//   - available_modifications (layer names + their accepted modification kinds)
//   - extended_defaults (open-ended bag of fields Bannerbear includes when
//     ?extended=true)
//   - missing_required_layers / missing_optional_layers (computed against
//     the template-design contract in templateMapping.ts)
//
// The snapshot is informational. The Element Manifest stays the source of
// truth — if a template is missing a layer, we re-design or re-snapshot;
// we don't change the manifest to fit Bannerbear.
// ─────────────────────────────────────────────────────────────────────────────

export const SYNCED_SNAPSHOT_PATH = path.join(
  process.cwd(),
  "data",
  "bannerbear-template-snapshots.generated.json",
);

export const TemplateSnapshotWithDiagnosticsSchema = BannerbearTemplateSnapshotSchema.extend({
  format: z.string(),
  missing_required_layers: z.array(z.string()),
  missing_optional_layers: z.array(z.string()),
});
export type TemplateSnapshotWithDiagnostics = z.infer<
  typeof TemplateSnapshotWithDiagnosticsSchema
>;

export const TemplateSnapshotsFileSchema = z.object({
  generated_at: z.string(),
  snapshots: z.array(TemplateSnapshotWithDiagnosticsSchema),
  errors: z.array(
    z.object({
      format: z.string(),
      template_uid: z.string().nullable(),
      message: z.string(),
    }),
  ),
});
export type TemplateSnapshotsFile = z.infer<typeof TemplateSnapshotsFileSchema>;

/**
 * Fetch + snapshot one template by UID. Computes missing required/optional
 * layers against the template-design contract.
 */
export async function syncBannerbearTemplate(
  templateUid: string,
  format: SupportedFormat,
): Promise<TemplateSnapshotWithDiagnostics> {
  const r: BannerbearTemplateResponse = await getBannerbearTemplate(templateUid, true);

  const available_modifications = (r.available_modifications ?? []).map((m) => ({
    name: String((m as Record<string, unknown>).name ?? ""),
    text: typeof (m as Record<string, unknown>).text === "string"
      ? ((m as Record<string, unknown>).text as string)
      : undefined,
    color: typeof (m as Record<string, unknown>).color === "string"
      ? ((m as Record<string, unknown>).color as string)
      : undefined,
    image_url: typeof (m as Record<string, unknown>).image_url === "string"
      ? ((m as Record<string, unknown>).image_url as string)
      : undefined,
    extra: pickExtras(m as Record<string, unknown>, ["name", "text", "color", "image_url"]),
  }));

  const layerNames = new Set(available_modifications.map((m) => m.name).filter(Boolean));
  const missing_required_layers = REQUIRED_BANNERBEAR_LAYERS.filter((n) => !layerNames.has(n));
  const missing_optional_layers = OPTIONAL_BANNERBEAR_LAYERS.filter((n) => !layerNames.has(n));

  // Persist the open-ended response shape minus fields we already extracted.
  const extended_defaults = pickExtras(r as Record<string, unknown>, [
    "uid",
    "name",
    "width",
    "height",
    "available_modifications",
  ]);

  return TemplateSnapshotWithDiagnosticsSchema.parse({
    template_uid: r.uid,
    template_name: r.name,
    width: r.width,
    height: r.height,
    available_modifications,
    extended_defaults,
    fetched_at: new Date().toISOString(),
    format,
    missing_required_layers: [...missing_required_layers],
    missing_optional_layers: [...missing_optional_layers],
  });
}

function pickExtras(
  obj: Record<string, unknown>,
  keysToOmit: string[],
): Record<string, unknown> {
  const omit = new Set(keysToOmit);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!omit.has(k)) out[k] = v;
  }
  return out;
}

export interface SyncAllResult {
  file: TemplateSnapshotsFile;
  outputPath: string;
}

/**
 * Sync all three configured templates, write the snapshots file, return
 * details for the calling script's summary output.
 */
export async function syncAllBannerbearTemplates(
  outputPath: string = SYNCED_SNAPSHOT_PATH,
): Promise<SyncAllResult> {
  const map = await getTemplateMap();
  const snapshots: TemplateSnapshotWithDiagnostics[] = [];
  const errors: TemplateSnapshotsFile["errors"] = [];

  for (const entry of map) {
    if (entry.template_uid == null) {
      errors.push({
        format: entry.format,
        template_uid: null,
        message: entry.error ?? "no template UID resolved",
      });
      continue;
    }
    try {
      const snap = await syncBannerbearTemplate(entry.template_uid, entry.format);
      snapshots.push(snap);
    } catch (err) {
      errors.push({
        format: entry.format,
        template_uid: entry.template_uid,
        message: (err as Error).message,
      });
    }
  }

  const file: TemplateSnapshotsFile = TemplateSnapshotsFileSchema.parse({
    generated_at: new Date().toISOString(),
    snapshots,
    errors,
  });
  await fs.writeFile(outputPath, JSON.stringify(file, null, 2) + "\n", "utf8");
  return { file, outputPath };
}

// ── Reader (used by the bannerbear-preview page) ────────────────────────────
export async function loadTemplateSnapshotsIfPresent(
  filePath: string = SYNCED_SNAPSHOT_PATH,
): Promise<TemplateSnapshotsFile | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return TemplateSnapshotsFileSchema.parse(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}
