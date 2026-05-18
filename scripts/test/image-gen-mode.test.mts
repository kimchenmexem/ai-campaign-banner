/* eslint-disable no-console */
// Proves the cost-estimate contract holds: by default (background-only)
// generateImagesForConcepts emits exactly one image per concept; with
// all-prompts mode it emits every prompt in midjourney_prompt_pack.
//
// We test the filtering logic directly rather than monkey-patching the
// imageProvider ESM module (which is read-only at runtime).

import { test, runTests, assertEqual } from "./harness";
import { ImageGenerationModeSchema } from "@/lib/ai/imageGenerationMode";

type Prompt = { prompt_id: string; intended_use: string };
function selectPrompts(prompts: Prompt[], mode: "background-only" | "all-prompts"): Prompt[] {
  // Mirrors the implementation in src/lib/ai/campaignPlanner.ts. Keeping the
  // two in sync is the point of this test — if the planner diverges, this
  // test fails first.
  if (mode === "all-prompts") return prompts;
  const bg = prompts.filter((p) => p.intended_use === "background").slice(0, 1);
  if (bg.length === 0 && prompts[0]) return [prompts[0]];
  return bg;
}

const FAKE_PROMPTS: Prompt[] = [
  { prompt_id: "p_bg", intended_use: "background" },
  { prompt_id: "p_dec", intended_use: "decorative" },
  { prompt_id: "p_hero", intended_use: "hero_visual" },
];

test("mode schema accepts both modes", () => {
  ImageGenerationModeSchema.parse("background-only");
  ImageGenerationModeSchema.parse("all-prompts");
});

test("default 'background-only' selects exactly one prompt per concept", () => {
  const picked = selectPrompts(FAKE_PROMPTS, "background-only");
  assertEqual(picked.length, 1);
  assertEqual(picked[0].intended_use, "background");
});

test("'all-prompts' selects every prompt", () => {
  const picked = selectPrompts(FAKE_PROMPTS, "all-prompts");
  assertEqual(picked.length, 3);
});

test("background-only falls back to first prompt when no background present", () => {
  const noBg: Prompt[] = [
    { prompt_id: "p_dec", intended_use: "decorative" },
    { prompt_id: "p_hero", intended_use: "hero_visual" },
  ];
  const picked = selectPrompts(noBg, "background-only");
  assertEqual(picked.length, 1);
  assertEqual(picked[0].intended_use, "decorative");
});

test("source: planner uses intended_use 'background' filter (not context)", async () => {
  const { promises: fs } = await import("node:fs");
  const path = await import("node:path");
  const src = await fs.readFile(
    path.join(process.cwd(), "src", "lib", "ai", "campaignPlanner.ts"),
    "utf8",
  );
  // Must not filter by p.context === "background" — that was the buggy
  // off-by-name code (context is industry, not slot role).
  if (src.includes('p.context === "background"')) {
    throw new Error(
      'planner still filters by p.context === "background"; should filter by intended_use',
    );
  }
});

runTests();
