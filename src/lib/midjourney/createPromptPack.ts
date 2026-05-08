import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  BrandKitLiteSchema,
  type BrandKitLite,
} from "@/lib/schemas/brandKit.schema";
import {
  DemoCampaignSchema,
  type DemoCampaign,
} from "@/lib/preview/createDemoCampaign";
import {
  MidjourneyPromptPackSchema,
  type MidjourneyAspectRatio,
  type MidjourneyContext,
  type MidjourneyIntendedUse,
  type MidjourneyPrompt,
  type MidjourneyPromptPack,
} from "@/lib/schemas/midjourney.schema";
import {
  createReferencePack,
  FORBIDDEN_OUTPUTS_LIST,
} from "@/lib/midjourney/createReferencePack";

// ─────────────────────────────────────────────────────────────────────────────
// Generate a Midjourney prompt pack.
//
// Reads brand kit + (optional) demo campaign, emits 7+ prompts covering the
// formats and visual roles the demo will likely consume:
//
//   1. premium_fintech background — 16:9
//   2. premium_fintech background — 1:1
//   3. premium_fintech background — 9:16
//   4. context-aware hero visual  — 16:9
//   5. context-aware hero visual  — 1:1
//   6. abstract decorative        — 1:1
//   7. moodboard                  — 16:9
//
// Every prompt embeds:
//   - brand color hex codes
//   - explicit "leave clean negative space for copy"
//   - the standard forbidden list (no text, no logo, no watermark, no UI text,
//     no fake screenshots, etc.)
//   - aspect-ratio param (`--ar W:H`)
//   - `--style raw` for editorial fidelity
//
// What Midjourney is NEVER allowed to generate (called out in every prompt
// and again in the docs): brand logo, IBKR/Powered by IB logo, CTA copy,
// disclaimer/legal text, readable UI text, or any text overlay.
// ─────────────────────────────────────────────────────────────────────────────

export const PROMPT_PACK_PATH = path.join(
  process.cwd(),
  "data",
  "midjourney-prompt-pack.generated.json",
);

const FORBIDDEN_LINE =
  "no text, no logo, no watermark, no CTA, no disclaimer, no readable UI text, no fake app screenshots, no brand logos, no IBKR logos, no people unless explicitly noted";

const STYLE_NOTES =
  "premium fintech editorial style, clean, elegant, trustworthy, modern, sophisticated, leave clean negative space for marketing copy";

interface CreatePromptPackOptions {
  cwd?: string;
  brandKitPath?: string;
  demoPath?: string;
  outputPath?: string;
  // Defaults to true. When true, the prompt pack is generated, then the
  // reference pack is generated, then per-prompt recommendations are
  // attached to the prompt pack and the file is rewritten. Pass false to
  // skip the reference pass entirely (legacy / fast mode).
  withReferences?: boolean;
}

export interface PromptPackResult {
  pack: MidjourneyPromptPack;
  outputPath: string;
  referencePackPath?: string;
}

export async function createPromptPack(
  opts: CreatePromptPackOptions = {},
): Promise<PromptPackResult> {
  const cwd = opts.cwd ?? process.cwd();
  const brandKitPath =
    opts.brandKitPath ?? path.join(cwd, "data", "brand-kit-lite.generated.json");
  const demoPath =
    opts.demoPath ?? path.join(cwd, "data", "demo-campaign.preview.json");
  const outputPath = opts.outputPath ?? PROMPT_PACK_PATH;

  const kit = BrandKitLiteSchema.parse(
    JSON.parse(await fs.readFile(brandKitPath, "utf8")),
  );
  const demo = await loadDemoOrNull(demoPath);

  const colorHexes = collectBrandColorHexes(kit);
  const palette = colorHexes.slice(0, 5).join(", ");

  const campaignId = demo?.campaign.id ?? "campaign_default";
  const createdAt = new Date().toISOString();

  // Map demo ad concepts (if available) to per-aspect contexts so each ad
  // size has a hero visual that fits its concept (stocks/etfs/charts/…).
  const heroPlanByAspect = new Map<MidjourneyAspectRatio, MidjourneyContext>();
  if (demo) {
    for (const spec of demo.ad_specs) {
      const aspect = aspectRatioForSize(spec.size.width, spec.size.height);
      const ctx = (spec.composite_metadata.desired_context ??
        "premium_fintech") as MidjourneyContext;
      heroPlanByAspect.set(aspect, ctx);
    }
  }

  const prompts: MidjourneyPrompt[] = [];

  // 1–3. Premium fintech backgrounds, one per aspect.
  for (const aspect of ["16:9", "1:1", "9:16"] as MidjourneyAspectRatio[]) {
    prompts.push(
      buildPrompt({
        id: `bg-premium-${aspect.replace(":", "x")}`,
        title: `Premium fintech background — ${aspect}`,
        intended_use: "background",
        context: "premium_fintech",
        aspect_ratio: aspect,
        scene:
          "abstract premium fintech background, deep navy gradient interior, soft luminous depth, minimal composition, restrained geometric data visualization in the far background, sense of calm and authority",
        palette,
        notes:
          "This is a background. Marketing copy will overlay the left third for 16:9, the top third for 1:1, the upper half for 9:16. Keep that area visually quiet.",
        campaign_id: campaignId,
        created_at: createdAt,
      }),
    );
  }

  // 4–5. Context-aware hero visuals, one per common aspect.
  for (const aspect of ["16:9", "1:1"] as MidjourneyAspectRatio[]) {
    const ctx = heroPlanByAspect.get(aspect) ?? "charts";
    prompts.push(
      buildPrompt({
        id: `hero-${ctx}-${aspect.replace(":", "x")}`,
        title: `Hero visual — ${ctx} — ${aspect}`,
        intended_use: "hero_visual",
        context: ctx,
        aspect_ratio: aspect,
        scene: heroSceneForContext(ctx),
        palette,
        notes:
          "Hero visual sits behind or alongside copy. Keep the focal area off-center so the copy block has a quiet zone.",
        campaign_id: campaignId,
        created_at: createdAt,
      }),
    );
  }

  // 6. Abstract decorative element.
  prompts.push(
    buildPrompt({
      id: "decorative-abstract-1x1",
      title: "Decorative abstract — 1:1",
      intended_use: "decorative",
      context: "premium_fintech",
      aspect_ratio: "1:1",
      scene:
        "small isolated abstract fintech accent shape — a single elegant geometric/data motif on a transparent-feeling background, subtle gradient, quiet composition, used as a decorative corner accent",
      palette,
      notes:
        "Will be placed at low opacity in a corner. Should read fine at 200×200px. Avoid strong directional gradients that would clash with the ad's main background.",
      campaign_id: campaignId,
      created_at: createdAt,
    }),
  );

  // 7. Moodboard prompt — for human reference / style validation.
  prompts.push(
    buildPrompt({
      id: "moodboard-fintech-16x9",
      title: "Brand moodboard — 16:9",
      intended_use: "moodboard",
      context: "premium_fintech",
      aspect_ratio: "16:9",
      scene:
        "editorial collage moodboard for a premium financial trading brand: macro charts, abstract data, soft navy/teal gradients, glass surfaces, restrained typography placeholders (no actual letters), depth of field, editorial photography mood",
      palette,
      notes:
        "Moodboard only — used for human reference, not as a render input. Helps the team agree on tone before approving hero visuals.",
      campaign_id: campaignId,
      created_at: createdAt,
    }),
  );

  const pack: MidjourneyPromptPack = MidjourneyPromptPackSchema.parse({
    pack_id: `pack_${shortId(`${campaignId}-${createdAt}`)}`,
    campaign_id: campaignId,
    brand_id: kit.brand_id,
    prompts,
    source: "system_generated",
    created_at: createdAt,
  });

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(pack, null, 2) + "\n", "utf8");

  // Reference pass — opt-out via withReferences:false. Run after writing the
  // initial pack so createReferencePack can read it from disk.
  let referencePackPath: string | undefined;
  if (opts.withReferences !== false) {
    try {
      const refResult = await createReferencePack({
        cwd,
        promptPackPath: outputPath,
      });
      referencePackPath = refResult.outputPath;

      // Re-stamp every prompt with its recommendations + the canonical
      // forbidden-output list, then rewrite the prompt pack file.
      const updatedPrompts: MidjourneyPrompt[] = pack.prompts.map((p) => ({
        ...p,
        recommended_references:
          refResult.recommendationsByPromptId.get(p.prompt_id) ?? [],
        forbidden_outputs: FORBIDDEN_OUTPUTS_LIST,
      }));
      const updatedPack = MidjourneyPromptPackSchema.parse({
        ...pack,
        prompts: updatedPrompts,
      });
      await fs.writeFile(
        outputPath,
        JSON.stringify(updatedPack, null, 2) + "\n",
        "utf8",
      );
      return { pack: updatedPack, outputPath, referencePackPath };
    } catch (err) {
      // Reference pass is best-effort. If selection fails (e.g. no asset
      // preview map yet), still return the prompt pack.
      console.warn(
        `createPromptPack: reference pass skipped — ${(err as Error).message}`,
      );
    }
  }

  return { pack, outputPath, referencePackPath };
}

interface BuildPromptArgs {
  id: string;
  title: string;
  intended_use: MidjourneyIntendedUse;
  context: MidjourneyContext;
  aspect_ratio: MidjourneyAspectRatio;
  scene: string;
  palette: string;
  notes: string;
  campaign_id: string;
  created_at: string;
}

function buildPrompt(args: BuildPromptArgs): MidjourneyPrompt {
  const promptText = [
    args.scene,
    `brand palette: ${args.palette}`,
    STYLE_NOTES,
    FORBIDDEN_LINE,
    `--ar ${args.aspect_ratio}`,
    "--style raw",
  ].join(", ");

  return {
    prompt_id: args.id,
    campaign_id: args.campaign_id,
    title: args.title,
    intended_use: args.intended_use,
    context: args.context,
    aspect_ratio: args.aspect_ratio,
    prompt_text: promptText,
    negative_instructions: [
      "no text",
      "no logo",
      "no watermark",
      "no CTA",
      "no disclaimer",
      "no readable UI text",
      "no fake app screenshots",
      "no brand logos",
      "no IBKR logos",
    ],
    style_reference_note: "[OPTIONAL_STYLE_REFERENCE_URL]",
    image_reference_note: "[OPTIONAL_IMAGE_REFERENCE_URL]",
    notes: args.notes,
    // Filled in by the reference pass below; keep empty defaults so callers
    // without the reference pass still get a valid MidjourneyPrompt.
    recommended_references: [],
    forbidden_outputs: [],
    created_at: args.created_at,
  };
}

function heroSceneForContext(ctx: MidjourneyContext): string {
  switch (ctx) {
    case "stocks":
      return "abstract premium stocks trading visualization — vertical column of restrained price indicators, ascending equity curve, glass and navy depth, no actual readable numbers";
    case "etfs":
      return "abstract diversified-portfolio motif — segmented circular pie-style accent, soft layering, no actual readable text or logos";
    case "charts":
      return "abstract upward-trending candlestick / line-chart motif, deep navy backdrop, soft luminous highlights on rising peaks, restrained, premium fintech";
    case "green_data":
      return "abstract upward-trending data motif with subtle green accents over deep navy gradient, sense of growth, sophisticated, no actual readable numbers";
    case "general_platform":
      return "abstract premium financial dashboard mood — segmented luminous panels suggesting modules, depth, no actual readable text";
    case "premium_fintech":
    default:
      return "abstract premium fintech motif — geometric depth, restrained luminous highlights, navy gradient base, editorial composition";
  }
}

async function loadDemoOrNull(p: string): Promise<DemoCampaign | null> {
  try {
    const raw = await fs.readFile(p, "utf8");
    return DemoCampaignSchema.parse(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function collectBrandColorHexes(kit: BrandKitLite): string[] {
  const hexes = new Set<string>();
  for (const c of kit.colors.primary) hexes.add(c);
  for (const c of kit.colors.secondary) hexes.add(c);
  for (const c of kit.colors.accent) hexes.add(c);
  for (const c of kit.colors.background) hexes.add(c);
  for (const g of kit.colors.allowed_gradients) {
    for (const stop of g.stops) hexes.add(stop.color);
  }
  return Array.from(hexes);
}

function aspectRatioForSize(w: number, h: number): MidjourneyAspectRatio {
  const ratio = w / h;
  if (Math.abs(ratio - 1) < 0.05) return "1:1";
  if (Math.abs(ratio - 16 / 9) < 0.1) return "16:9";
  if (Math.abs(ratio - 4 / 5) < 0.05) return "4:5";
  if (ratio < 1) return "9:16";
  return "16:9";
}

function shortId(seed: string): string {
  return crypto.createHash("sha1").update(seed).digest("hex").slice(0, 8);
}
