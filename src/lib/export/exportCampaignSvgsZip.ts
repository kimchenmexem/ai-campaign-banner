import JSZip from "jszip";
import type { CampaignPlan } from "@/lib/schemas/aiCampaignPlan.schema";
import { exportAdSvg } from "@/lib/export/exportAdSvg";

// ─────────────────────────────────────────────────────────────────────────────
// SVG-only ZIP export.
//
// Bundles one SVG per banner — nothing else. Lighter than exportCampaignPlanZip
// (no PNGs / manifests / prompts) and unlike the full ZIP it has NO render
// dependency: it works directly from campaign-plan.json before the operator
// has clicked "Render Campaign".
//
// embedLocalImages defaults to FALSE here (the opposite of single-SVG export).
// Reason: when an ad references a large product asset (e.g. a 2.5MB ipad.png)
// base64-embedding inflates a single SVG past Vercel's ~4.5MB serverless
// response cap. With remote refs the SVG stays small (Cloudinary URLs
// resolve on Figma import). Operators who need a fully-self-contained file
// can pass ?embed=1 — that will use Cloudinary URLs for assets that fail
// to fit, since exportAdSvg already handles remote URLs gracefully.
//
// Output layout:
//   campaign-{id}-svgs.zip
//   ├── concept_<concept_id>_<format>.svg
//   ├── …
//   └── README.txt   (1-line orientation)
// ─────────────────────────────────────────────────────────────────────────────

export interface ExportCampaignSvgsResult {
  buffer: Uint8Array;
  filename: string;
  byteLength: number;
  /** ad_ids that succeeded. */
  succeeded: string[];
  /** ad_ids that threw + their error message. */
  failed: Array<{ ad_id: string; error: string }>;
}

export async function exportCampaignSvgsZip(args: {
  plan: CampaignPlan;
  cwd?: string;
  embedLocalImages?: boolean;
}): Promise<ExportCampaignSvgsResult> {
  const { plan } = args;
  const embedLocalImages = args.embedLocalImages ?? false;
  const zip = new JSZip();

  const succeeded: string[] = [];
  const failed: Array<{ ad_id: string; error: string }> = [];

  // Group SVGs by concept for tidy archive structure.
  for (const concept of plan.concepts) {
    const conceptFolder = zip.folder(concept.concept_id) ?? zip;
    for (const ad of concept.ad_specs) {
      try {
        const result = await exportAdSvg({
          plan,
          adId: ad.ad_id,
          cwd: args.cwd,
          embedLocalImages,
        });
        // Filename pattern: <concept>_<format>.svg — same convention the
        // full plan-ZIP uses for its figma-svgs/ folder.
        const filename = `${concept.concept_id}_${ad.format}.svg`;
        conceptFolder.file(filename, result.svg);
        succeeded.push(ad.ad_id);
      } catch (err) {
        failed.push({ ad_id: ad.ad_id, error: (err as Error).message });
      }
    }
  }

  // 1-line README so the recipient knows what they're holding.
  zip.file(
    "README.txt",
    [
      `Campaign: ${plan.campaign_id}`,
      `Generated: ${new Date().toISOString()}`,
      `Banners: ${succeeded.length} succeeded${failed.length ? `, ${failed.length} failed` : ""}`,
      `Mode: ${embedLocalImages ? "embedded (data URIs)" : "remote refs (Cloudinary)"}`,
      ``,
      `Drag any SVG into Figma — text stays editable, images embedded or fetched on import.`,
    ].join("\n"),
  );

  if (failed.length > 0) {
    zip.file(
      "FAILED.txt",
      failed.map((f) => `${f.ad_id}: ${f.error}`).join("\n"),
    );
  }

  const buffer = await zip.generateAsync({ type: "uint8array" });

  return {
    buffer,
    filename: `campaign-${plan.campaign_id}-svgs.zip`,
    byteLength: buffer.byteLength,
    succeeded,
    failed,
  };
}
