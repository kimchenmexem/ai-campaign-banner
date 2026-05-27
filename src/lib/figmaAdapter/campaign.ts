import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { LANGUAGES, LanguageSchema } from "@/lib/i18n/language";
import { CampaignFormatSchema } from "@/lib/schemas/campaignBrief.schema";
import {
  CampaignIndexFileSchema,
  type CampaignIndexEntry,
  type CampaignIndexFile,
} from "@/lib/schemas/aiCampaignPlan.schema";

export const FigmaAdapterVariantSchema = z.object({
  key: z.string().min(1),
  language: LanguageSchema,
  format: CampaignFormatSchema,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  svg: z.string().min(1).max(8_000_000),
  warnings: z.array(z.string()).default([]),
});
export type FigmaAdapterVariant = z.infer<typeof FigmaAdapterVariantSchema>;

export const SaveFigmaAdapterCampaignSchema = z.object({
  campaign_name: z.string().trim().min(1).max(120).optional(),
  brand_id: z.string().trim().min(1).max(80).default("brand_001"),
  source_summary: z.object({
    width: z.number().positive(),
    height: z.number().positive(),
    text_layer_count: z.number().int().nonnegative(),
  }),
  formats: z.array(CampaignFormatSchema).min(1),
  languages: z.array(LanguageSchema).min(1).max(LANGUAGES.length),
  variants: z.array(FigmaAdapterVariantSchema).min(1).max(120),
  warnings: z.array(z.string()).default([]),
});
export type SaveFigmaAdapterCampaignInput = z.infer<
  typeof SaveFigmaAdapterCampaignSchema
>;

export const FigmaAdapterCampaignSchema =
  SaveFigmaAdapterCampaignSchema.extend({
    campaign_id: z.string().min(1),
    campaign_name: z.string().min(1),
    campaign_summary: z.string().min(1),
    source: z.literal("figma-adapter"),
    ai_provider: z.literal("mock"),
    created_at: z.string(),
  });
export type FigmaAdapterCampaign = z.infer<typeof FigmaAdapterCampaignSchema>;

export async function saveFigmaAdapterCampaign(
  input: SaveFigmaAdapterCampaignInput,
  cwd: string = process.cwd(),
): Promise<{ campaign: FigmaAdapterCampaign; savedPath: string }> {
  const createdAt = new Date().toISOString();
  const campaignId = `cam_figma_${shortId(`${createdAt}-${crypto.randomUUID()}`)}`;
  const campaignName =
    input.campaign_name?.trim() || `Figma Adapter ${formatTimestamp(createdAt)}`;
  const campaign: FigmaAdapterCampaign = FigmaAdapterCampaignSchema.parse({
    ...input,
    campaign_id: campaignId,
    campaign_name: campaignName,
    campaign_summary: `Figma source banner adapted into ${input.variants.length} editable SVG variants across ${input.languages.length} language${input.languages.length === 1 ? "" : "s"} and ${input.formats.length} format${input.formats.length === 1 ? "" : "s"}.`,
    source: "figma-adapter",
    ai_provider: "mock",
    created_at: createdAt,
  });

  const dir = path.join(cwd, "data", "campaigns", campaign.campaign_id);
  const svgDir = path.join(dir, "svgs");
  await fs.mkdir(svgDir, { recursive: true });

  for (const variant of campaign.variants) {
    await fs.writeFile(
      path.join(svgDir, `${variant.language}-${variant.format}.svg`),
      variant.svg.endsWith("\n") ? variant.svg : `${variant.svg}\n`,
      "utf8",
    );
  }
  await fs.writeFile(
    path.join(dir, "all-banners.svg"),
    buildFigmaAdapterCombinedSvg(campaign.variants),
    "utf8",
  );
  const savedPath = path.join(dir, "figma-adapter-campaign.generated.json");
  await fs.writeFile(savedPath, JSON.stringify(campaign, null, 2) + "\n", "utf8");
  await upsertFigmaAdapterCampaignIndex(cwd, campaign);
  return { campaign, savedPath };
}

export async function loadFigmaAdapterCampaignIfExists(
  campaignId: string,
  cwd: string = process.cwd(),
): Promise<FigmaAdapterCampaign | null> {
  const filePath = path.join(
    cwd,
    "data",
    "campaigns",
    campaignId,
    "figma-adapter-campaign.generated.json",
  );
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return FigmaAdapterCampaignSchema.parse(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export function buildFigmaAdapterCombinedSvg(variants: FigmaAdapterVariant[]): string {
  const gap = 72;
  const labelHeight = 36;
  const columns = Math.min(3, Math.max(1, Math.ceil(Math.sqrt(variants.length))));
  const rows: FigmaAdapterVariant[][] = [];
  for (let i = 0; i < variants.length; i += columns) {
    rows.push(variants.slice(i, i + columns));
  }
  const colWidths = Array.from({ length: columns }, (_, col) =>
    Math.max(...rows.map((row) => row[col]?.width ?? 0), 0),
  );
  const rowHeights = rows.map((row) => Math.max(...row.map((item) => item.height), 0));
  const width =
    colWidths.reduce((sum, value) => sum + value, 0) + gap * Math.max(0, columns + 1);
  const height =
    rowHeights.reduce((sum, value) => sum + value + labelHeight, 0) +
    gap * Math.max(0, rows.length + 1);
  const pieces = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" data-source="figma-adapter-combined">`,
    `<rect width="${width}" height="${height}" fill="#F4F4F5"/>`,
  ];
  let y = gap;
  rows.forEach((row, rowIndex) => {
    let x = gap;
    row.forEach((variant, colIndex) => {
      pieces.push(
        `<text x="${x}" y="${y}" font-family="Inter, Arial, sans-serif" font-size="18" font-weight="700" fill="#18181B">${escXml(variant.language.toUpperCase())} · ${escXml(variant.format)}</text>`,
      );
      pieces.push(
        `<svg x="${x}" y="${y + labelHeight}" width="${variant.width}" height="${variant.height}" viewBox="0 0 ${variant.width} ${variant.height}" overflow="visible">`,
      );
      pieces.push(prefixSvgIds(extractSvgInner(variant.svg), `v${rowIndex}_${colIndex}_`));
      pieces.push(`</svg>`);
      x += colWidths[colIndex] + gap;
    });
    y += rowHeights[rowIndex] + labelHeight + gap;
  });
  pieces.push(`</svg>`);
  return pieces.join("\n") + "\n";
}

async function upsertFigmaAdapterCampaignIndex(
  cwd: string,
  campaign: FigmaAdapterCampaign,
): Promise<void> {
  const filePath = path.join(cwd, "data", "campaigns", "index.generated.json");
  let file: CampaignIndexFile;
  try {
    file = CampaignIndexFileSchema.parse(
      JSON.parse(await fs.readFile(filePath, "utf8")),
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    file = {
      generated_at: new Date().toISOString(),
      active_campaign_id: null,
      campaigns: [],
    };
  }
  const entry: CampaignIndexEntry = {
    campaign_id: campaign.campaign_id,
    source: "figma-adapter",
    brand_id: campaign.brand_id,
    campaign_name: campaign.campaign_name,
    ai_provider: "mock",
    concept_count: campaign.languages.length,
    ad_count: campaign.variants.length,
    created_at: campaign.created_at,
    active: file.active_campaign_id === campaign.campaign_id,
    rendered: true,
  };
  const next: CampaignIndexFile = {
    generated_at: new Date().toISOString(),
    active_campaign_id: file.active_campaign_id,
    campaigns: [
      entry,
      ...file.campaigns.filter((item) => item.campaign_id !== campaign.campaign_id),
    ],
  };
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(next, null, 2) + "\n", "utf8");
}

function prefixSvgIds(svg: string, prefix: string): string {
  const ids = new Set<string>();
  const idRegex = /\bid=(["'])([^"']+)\1/g;
  let match: RegExpExecArray | null;
  while ((match = idRegex.exec(svg)) !== null) ids.add(match[2]);
  let out = svg;
  for (const id of ids) {
    const nextId = `${prefix}${id}`;
    out = out.replace(
      new RegExp(`\\bid=(["'])${escapeRegExp(id)}\\1`, "g"),
      (_match, quote: string) => `id=${quote}${nextId}${quote}`,
    );
    out = out.replace(new RegExp(`url\\(#${escapeRegExp(id)}\\)`, "g"), `url(#${nextId})`);
    out = out.replace(
      new RegExp(`href=(["'])#${escapeRegExp(id)}\\1`, "g"),
      (_match, quote: string) => `href=${quote}#${nextId}${quote}`,
    );
    out = out.replace(
      new RegExp(`xlink:href=(["'])#${escapeRegExp(id)}\\1`, "g"),
      (_match, quote: string) => `xlink:href=${quote}#${nextId}${quote}`,
    );
  }
  return out;
}

function extractSvgInner(svg: string): string {
  const open = svg.match(/<svg\b[^>]*>/i);
  if (!open || open.index === undefined) return svg;
  const bodyStart = open.index + open[0].length;
  const bodyEnd = svg.lastIndexOf("</svg>");
  return bodyEnd > bodyStart ? svg.slice(bodyStart, bodyEnd).trim() : svg;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function shortId(seed: string): string {
  return crypto.createHash("sha1").update(seed).digest("hex").slice(0, 8);
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  return date.toISOString().slice(0, 16).replace("T", " ");
}
