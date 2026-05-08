import { promises as fs } from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import type { CampaignPlan } from "@/lib/schemas/aiCampaignPlan.schema";
import { exportAdSvg } from "@/lib/export/exportAdSvg";

// ─────────────────────────────────────────────────────────────────────────────
// Build a self-contained ZIP of a CampaignPlan ready for handoff to a media
// buyer / agency / Bannerbear / Figma operator. Layout inside the archive:
//
//   campaign-{id}.zip
//   ├── README.md               Quick orientation, brief, scores
//   ├── campaign-plan.json      The validated CampaignPlan (source of truth)
//   ├── pngs/
//   │   ├── concept_1_1200x628.png
//   │   ├── concept_1_1080x1080.png
//   │   └── ...
//   ├── manifests/
//   │   ├── ad_concept_1_1200x628.manifest.json
//   │   └── ...
//   ├── figma-svgs/             One SVG per banner — drag into Figma
//   │   ├── concept_1_1200x628.svg
//   │   └── ...
//   ├── prompts/
//   │   ├── concept_1.midjourney-prompts.txt
//   │   └── ...
//   └── quality/
//       └── render-quality-map.json   (when vision scoring was run)
//
// Anything that can be reproduced from the plan is included as a real file
// — operators on the receiving end don't need the dev environment.
// ─────────────────────────────────────────────────────────────────────────────

export interface ExportPlanResult {
  buffer: Uint8Array;
  filename: string;
  byteLength: number;
}

export async function exportCampaignPlanZip(args: {
  cwd?: string;
  plan: CampaignPlan;
}): Promise<ExportPlanResult> {
  const cwd = args.cwd ?? process.cwd();
  const { plan } = args;
  const zip = new JSZip();

  // 1. The plan itself — source of truth.
  zip.file("campaign-plan.json", JSON.stringify(plan, null, 2));

  // 2. PNGs from the render-map (when present).
  const pngsDir = zip.folder("pngs")!;
  const renderMapPath = path.join(
    cwd,
    "data",
    "campaigns",
    plan.campaign_id,
    "code-render-map.generated.json",
  );
  const renderMap = await readJsonOrNull<{ items: Array<{ ad_id: string; concept_id: string | null; format: string; output_local_path: string | null; status: string }> }>(renderMapPath);
  if (renderMap) {
    for (const item of renderMap.items) {
      if (item.status !== "completed" || !item.output_local_path) continue;
      const abs = path.resolve(cwd, item.output_local_path);
      try {
        const buf = await fs.readFile(abs);
        const filename = `${item.concept_id ?? "concept"}_${item.format}.png`;
        pngsDir.file(filename, buf);
      } catch {
        // Skip missing files silently — partial exports are still useful.
      }
    }
  }

  // 3. Per-ad Element Manifests as standalone JSON files.
  const manifestsDir = zip.folder("manifests")!;
  for (const concept of plan.concepts) {
    for (const ad of concept.ad_specs) {
      manifestsDir.file(
        `${ad.ad_id}.manifest.json`,
        JSON.stringify(ad.manifest, null, 2),
      );
    }
  }

  // 4. Per-ad SVGs ready for Figma drag-and-drop. One file per banner with
  //    real <text> nodes (text stays editable in Figma) and image bytes
  //    embedded as base64 data URIs (so the ZIP is portable). Designers can
  //    extract any single banner without needing the dev server.
  const svgsDir = zip.folder("figma-svgs")!;
  for (const concept of plan.concepts) {
    for (const ad of concept.ad_specs) {
      try {
        const result = await exportAdSvg({ plan, adId: ad.ad_id, cwd });
        const filename = `${concept.concept_id}_${ad.format}.svg`;
        svgsDir.file(filename, result.svg);
      } catch {
        // Skip individual SVG failures — the rest of the bundle still ships.
      }
    }
  }

  // 5. Midjourney prompt packs as ready-to-paste text per concept.
  const promptsDir = zip.folder("prompts")!;
  for (const concept of plan.concepts) {
    if (concept.midjourney_prompt_pack.length === 0) continue;
    const lines = [
      `# ${concept.name}`,
      `# concept_id: ${concept.concept_id}`,
      `# desired_visual_context: ${concept.desired_visual_context}`,
      ``,
      ...concept.midjourney_prompt_pack.flatMap((p) => [
        `## ${p.prompt_id}  (${p.intended_use}, ${p.aspect_ratio})`,
        p.prompt_text,
        ``,
      ]),
    ];
    promptsDir.file(`${concept.concept_id}.midjourney-prompts.txt`, lines.join("\n"));
  }

  // 6. Human-readable README. First file the recipient opens.
  zip.file("README.md", buildReadme(plan, renderMap?.items.length ?? 0));

  const buffer = await zip.generateAsync({ type: "uint8array" });
  return {
    buffer,
    filename: `campaign-${plan.campaign_id}.zip`,
    byteLength: buffer.byteLength,
  };
}

async function readJsonOrNull<T>(p: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(p, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function buildReadme(
  plan: CampaignPlan,
  pngCount: number,
): string {
  const adCount = plan.concepts.reduce((acc, c) => acc + c.ad_specs.length, 0);
  const formats = Array.from(
    new Set(plan.concepts.flatMap((c) => c.ad_specs.map((a) => a.format))),
  );
  const lines = [
    `# ${plan.campaign_name}`,
    ``,
    plan.campaign_summary,
    ``,
    `**Campaign id:** \`${plan.campaign_id}\``,
    `**Brand id:** \`${plan.brand_id}\``,
    `**Provider:** \`${plan.ai_provider}\``,
    `**Created:** ${new Date(plan.created_at).toLocaleString()}`,
    `**Concepts:** ${plan.concepts.length} · **Ads:** ${adCount} · **Formats:** ${formats.join(", ")}`,
    `**PNGs included:** ${pngCount}`,
    ``,
    `## Brief`,
    ``,
    `- **Marketing message:** ${plan.source_brief.marketing_message}`,
    ...(plan.source_brief.target_audience
      ? [`- **Target audience:** ${plan.source_brief.target_audience}`]
      : []),
    `- **Goal:** ${plan.source_brief.campaign_goal}`,
    `- **Tone:** ${plan.source_brief.tone.join(", ")}`,
    `- **Language:** ${plan.source_brief.language}`,
    `- **Risk warning required:** ${plan.source_brief.risk_warning_required}`,
    ``,
    `## Concepts`,
    ``,
  ];
  for (const c of plan.concepts) {
    lines.push(`### ${c.name}`);
    lines.push(``);
    lines.push(`- **Concept id:** \`${c.concept_id}\``);
    lines.push(`- **Strategic idea:** ${c.strategic_idea}`);
    lines.push(`- **Headline:** ${c.copy_package.headline}`);
    lines.push(`- **Subheadline:** ${c.copy_package.subheadline}`);
    lines.push(`- **CTA:** ${c.copy_package.cta}`);
    if (c.design_elements?.eyebrow) {
      lines.push(`- **Eyebrow:** ${c.design_elements.eyebrow}`);
    }
    if (c.design_elements?.stat) {
      lines.push(
        `- **Stat:** ${c.design_elements.stat.number} / ${c.design_elements.stat.label}`,
      );
    }
    lines.push(`- **Disclaimer:** ${c.copy_package.disclaimer}`);
    lines.push(``);
  }
  lines.push(`## Folder layout`);
  lines.push(``);
  lines.push("- `campaign-plan.json` — the full validated `CampaignPlan` (Zod-checked, source of truth).");
  lines.push("- `pngs/` — flat banners, one per (concept × format).");
  lines.push("- `manifests/` — per-ad Element Manifests, the layered JSON description any renderer (Bannerbear, Figma, code) can ingest.");
  lines.push("- `figma-svgs/` — drag-and-drop into Figma. One SVG per banner. Text stays as editable <text> nodes (Poppins/Heebo/Cairo families honoured by name); images embedded as base64 data URIs so the file is portable.");
  lines.push("- `prompts/` — ready-to-paste Midjourney prompts grouped per concept.");
  return lines.join("\n");
}
