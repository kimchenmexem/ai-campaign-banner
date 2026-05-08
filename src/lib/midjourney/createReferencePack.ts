import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  MidjourneyPromptPackSchema,
  MidjourneyReferencePackSchema,
  type MidjourneyPrompt,
  type MidjourneyPromptPack,
  type MidjourneyPromptReference,
  type MidjourneyReferenceClassified,
  type MidjourneyReferencePack,
  type MidjourneyReferencePerPrompt,
} from "@/lib/schemas/midjourney.schema";
import {
  selectReferenceAssets,
  type MidjourneyClassifiedAsset,
} from "@/lib/midjourney/selectReferenceAssets";

// ─────────────────────────────────────────────────────────────────────────────
// Reference Pack builder.
//
// Given the prompt pack + classified assets, produce two things:
//   1. A reference pack file (data/midjourney-reference-pack.generated.json)
//      with per-prompt selected references + the global classification.
//   2. A list of references-per-prompt that the prompt-pack generator embeds
//      back into each MidjourneyPrompt as `recommended_references`.
//
// The selection rules per intended_use:
//   - background:  up to 3 backgrounds + 1 element accent
//   - hero_visual: up to 1 background (atmosphere only) — never screenshots
//                  or mockups
//   - decorative:  up to 4 element style refs
//   - moodboard:   up to 2 backgrounds + 2 elements
//   - texture:     up to 3 elements
// ─────────────────────────────────────────────────────────────────────────────

export const PROMPT_PACK_PATH = path.join(
  process.cwd(),
  "data",
  "midjourney-prompt-pack.generated.json",
);
export const REFERENCE_PACK_PATH = path.join(
  process.cwd(),
  "data",
  "midjourney-reference-pack.generated.json",
);
export const REFERENCE_PUBLIC_DIR = "midjourney-reference-pack"; // under /public

const MAX_REFS_PER_PROMPT: Record<MidjourneyPrompt["intended_use"], number> = {
  background: 4,
  hero_visual: 2,
  decorative: 4,
  moodboard: 4,
  texture: 3,
};

interface SelectionPolicy {
  // Which canonical folder types to draw from, in order. We pick the first
  // few that classified as `style_reference`.
  preferred_folder_types: string[];
  // Maximum total references to recommend.
  max_count: number;
  // Whether to include `examples/` (always yes when present).
  include_examples: boolean;
}

const POLICY_BY_USE: Record<MidjourneyPrompt["intended_use"], SelectionPolicy> = {
  background: {
    preferred_folder_types: ["backgrounds", "elements", "examples"],
    max_count: MAX_REFS_PER_PROMPT.background,
    include_examples: true,
  },
  hero_visual: {
    preferred_folder_types: ["backgrounds", "examples"],
    max_count: MAX_REFS_PER_PROMPT.hero_visual,
    include_examples: true,
  },
  decorative: {
    preferred_folder_types: ["elements", "examples"],
    max_count: MAX_REFS_PER_PROMPT.decorative,
    include_examples: true,
  },
  moodboard: {
    preferred_folder_types: ["backgrounds", "elements", "examples"],
    max_count: MAX_REFS_PER_PROMPT.moodboard,
    include_examples: true,
  },
  texture: {
    preferred_folder_types: ["elements", "backgrounds", "examples"],
    max_count: MAX_REFS_PER_PROMPT.texture,
    include_examples: true,
  },
};

// Canonical "do not generate" list. Restated per prompt so the UI can show
// it next to each card; the prompt text itself already encodes the same.
const FORBIDDEN_OUTPUTS_LIST = [
  "Do not generate text of any kind",
  "Do not generate the brand logo",
  "Do not generate the IBKR / Powered by IB logo",
  "Do not generate readable app UI text",
  "Do not generate disclaimers or risk warnings",
  "Do not generate fake app screenshots",
  "Do not generate watermarks",
];

export interface CreateReferencePackOptions {
  cwd?: string;
  promptPackPath?: string;
  outputPath?: string;
}

export interface CreateReferencePackResult {
  pack: MidjourneyReferencePack;
  outputPath: string;
  // Per-prompt selections in the same shape the prompt pack embeds. Returned
  // so createPromptPack.ts can attach without re-running the selection logic.
  recommendationsByPromptId: Map<string, MidjourneyPromptReference[]>;
}

export async function createReferencePack(
  opts: CreateReferencePackOptions = {},
): Promise<CreateReferencePackResult> {
  const cwd = opts.cwd ?? process.cwd();
  const promptPackPath = opts.promptPackPath ?? PROMPT_PACK_PATH;
  const outputPath = opts.outputPath ?? REFERENCE_PACK_PATH;

  const promptPack: MidjourneyPromptPack = MidjourneyPromptPackSchema.parse(
    JSON.parse(await fs.readFile(promptPackPath, "utf8")),
  );

  const { classified, by_role } = await selectReferenceAssets({ cwd });

  const recommendationsByPromptId = new Map<string, MidjourneyPromptReference[]>();
  const perPrompt: MidjourneyReferencePerPrompt[] = [];

  for (const prompt of promptPack.prompts) {
    const policy = POLICY_BY_USE[prompt.intended_use];
    const candidates = pickCandidates(by_role.style_reference, policy);
    const selected = candidates.slice(0, policy.max_count);

    const inline: MidjourneyPromptReference[] = selected.map((c) => ({
      local_path: c.local_path,
      public_path: c.public_path,
      cloudinary_secure_url: c.cloudinary_secure_url,
      filename: c.filename,
      asset_type: c.asset_type,
      midjourney_role: "style_reference",
      why_selected: whySelected(prompt, c),
    }));
    recommendationsByPromptId.set(prompt.prompt_id, inline);

    perPrompt.push({
      prompt_id: prompt.prompt_id,
      intended_use: prompt.intended_use,
      context: prompt.context,
      aspect_ratio: prompt.aspect_ratio,
      selected_reference_assets: selected.map((c) => ({
        local_path: c.local_path,
        public_path: c.public_path,
        cloudinary_secure_url: c.cloudinary_secure_url,
        cloudinary_public_id: c.cloudinary_public_id,
        filename: c.filename,
        asset_type: c.asset_type,
        canonical_folder_type: c.canonical_folder_type,
        midjourney_role: "style_reference",
        reason: c.reason,
        why_selected: whySelected(prompt, c),
        // Filled in by the export script when it copies the file under public/.
        local_copy_path: null,
        public_copy_path: null,
      })),
      style_reference_assets: by_role.style_reference,
      avoid_assets: by_role.avoid_for_midjourney,
      usage_notes:
        "Drop these as Midjourney style references (drag into the prompt or use --sref with a re-uploaded URL). They are NOT image prompts — Midjourney should not copy their content, only their atmosphere/colors. Always re-state the forbidden list in the prompt.",
      manual_steps: [
        "1. Copy the prompt text from /midjourney.",
        "2. Re-upload the chosen reference images to a Midjourney-accessible URL (Discord upload, --sref, or paste into the prompt).",
        "3. Run the prompt in Midjourney.",
        "4. Pick a result and download the file.",
        "5. Upload the file at /midjourney → Uploads.",
        "6. Approve the upload and run `npm run preview:demo`.",
      ],
    });
  }

  const pack: MidjourneyReferencePack = MidjourneyReferencePackSchema.parse({
    pack_id: `refpack_${shortId(`${promptPack.pack_id}-${new Date().toISOString()}`)}`,
    campaign_id: promptPack.campaign_id,
    brand_id: promptPack.brand_id,
    generated_at: new Date().toISOString(),
    prompts: perPrompt,
    classifications: {
      style_reference: by_role.style_reference,
      image_prompt_reference: by_role.image_prompt_reference,
      avoid_for_midjourney: by_role.avoid_for_midjourney,
    },
    source: "system_generated",
  });

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(pack, null, 2) + "\n", "utf8");

  // Quiet usage of `classified` so future contributors can see we walked it.
  void classified;

  return { pack, outputPath, recommendationsByPromptId };
}

function pickCandidates(
  styleRefs: MidjourneyClassifiedAsset[],
  policy: SelectionPolicy,
): MidjourneyClassifiedAsset[] {
  const out: MidjourneyClassifiedAsset[] = [];
  // Pick from preferred folder types in order.
  for (const folder of policy.preferred_folder_types) {
    if (folder === "examples") continue; // handled below
    for (const a of styleRefs) {
      if (a.canonical_folder_type === folder) out.push(a);
    }
  }
  // Always include examples if requested + present (they're brand-approved).
  if (policy.include_examples) {
    for (const a of styleRefs) {
      if (a.canonical_folder_type === "examples" && !out.includes(a)) out.push(a);
    }
  }
  return out;
}

function whySelected(
  prompt: MidjourneyPrompt,
  asset: MidjourneyClassifiedAsset,
): string {
  switch (prompt.intended_use) {
    case "background":
      if (asset.canonical_folder_type === "backgrounds") {
        return "Brand background — match atmosphere/colors.";
      }
      if (asset.canonical_folder_type === "elements") {
        return "Brand decorative element — useful for accent atmosphere.";
      }
      return "Brand-approved style benchmark.";
    case "hero_visual":
      return "Atmosphere only — Midjourney should not copy content, only color + mood.";
    case "decorative":
      return "Decorative element — guides accent style.";
    case "moodboard":
      return "Brand reference for the moodboard.";
    case "texture":
      return "Surface/texture inspiration for style ref.";
    default:
      return "Style reference.";
  }
}

function shortId(seed: string): string {
  return crypto.createHash("sha1").update(seed).digest("hex").slice(0, 8);
}

export { FORBIDDEN_OUTPUTS_LIST };
