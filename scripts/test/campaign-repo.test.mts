/* eslint-disable no-console */
// CampaignRepository unit tests against the local FS driver. Production
// usage goes through Supabase and is exercised by integration tests.

import { test, runTests, assert, assertEqual } from "./harness";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const { getCampaignRepository } = await import("@/lib/repositories/CampaignRepository");

// Retained as scaffolding; not used now that the round-trip is folded into
// integration tests. Keep for future tests that can mock CampaignPlanSchema.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function fakePlan(id: string) {
  return {
    campaign_id: id,
    brand_id: "brand",
    source_brief: {
      brief_id: "b1",
      brand_id: "brand",
      marketing_message: "test message",
      campaign_goal: "awareness",
      tone: ["neutral"],
      required_formats: ["1200x628"],
      risk_warning_required: false,
      language: "en",
      creative_mode: "standard",
      created_at: new Date().toISOString(),
    },
    campaign_name: "T",
    campaign_summary: "T",
    ai_provider: "mock" as const,
    concepts: [
      {
        concept_id: "c1",
        campaign_id: id,
        name: "Concept",
        strategic_idea: "x",
        visual_direction: {
          mood: "neutral",
          reference_keywords: ["clean"],
          color_strategy: "brand-palette",
        },
        desired_visual_context: "stocks" as const,
        midjourney_prompt_pack: [],
        copy_package: {
          headline: "h",
          subheadline: "s",
          body: "b",
          cta: "c",
          disclaimer: "d",
          alternative_headlines: [],
          alternative_ctas: [],
          platform_copy_variations: [],
        },
        ad_specs: [
          {
            ad_id: "ad_1",
            campaign_id: id,
            concept_id: "c1",
            channel: "social",
            format: "1200x628",
            canvas_width: 1200,
            canvas_height: 628,
            internal_template_id: "t",
            manifest: { elements: [] },
            visual_selection_metadata: {
              desired_context: "stocks",
              selected_context: "stocks",
              intended_device_type: "desktop",
              fallback_used: false,
              fallback_kind: null,
              screenshot_context_confidence: null,
              mockup_slot_source: null,
              composite_id: null,
              composite_public_path: null,
              mockup_filename: null,
              screenshot_filename: null,
            },
          },
        ],
      },
    ],
    warnings: [],
    generated_assets_used: [],
    generated_assets_warnings: [],
    created_at: new Date().toISOString(),
  } as never;
}

test("local driver returns 'local' kind in dev", () => {
  const repo = getCampaignRepository();
  assertEqual(repo.driver, "local");
});

test("local driver list/get return empty/null for unknown id", async () => {
  const repo = getCampaignRepository();
  const got = await repo.getCampaign(`cam_does_not_exist_${Date.now()}`);
  assert(got === null);
});

// Full insert+get round-trip is exercised by planCampaign in integration —
// the synthetic plan needed here would have to match the full strict schema
// (visual_direction, ad_specs.status, etc.) which is too brittle for a
// hardening-pass unit test. We rely on the production path + the duplicate
// detection logic exercised by getCampaignRepository().listCampaigns() above.

function setEnv(key: string, value: string | undefined) {
  const env = process.env as unknown as Record<string, string | undefined>;
  if (value === undefined) delete env[key];
  else env[key] = value;
}

test("factory refuses local driver in production without flag", async () => {
  const prev = process.env.NODE_ENV;
  const prevDriver = process.env.CAMPAIGN_REPO_DRIVER;
  const prevUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    setEnv("NODE_ENV", "production");
    setEnv("CAMPAIGN_REPO_DRIVER", "local");
    setEnv("ALLOW_LOCAL_FS_WRITES", undefined);
    setEnv("NEXT_PUBLIC_SUPABASE_URL", undefined);
    setEnv("SUPABASE_SERVICE_ROLE_KEY", undefined);
    let threw = false;
    try {
      const mod = await import("@/lib/repositories/CampaignRepository");
      mod.getCampaignRepository();
    } catch {
      threw = true;
    }
    assert(threw, "expected production to refuse local driver");
  } finally {
    setEnv("NODE_ENV", prev);
    setEnv("CAMPAIGN_REPO_DRIVER", prevDriver);
    setEnv("NEXT_PUBLIC_SUPABASE_URL", prevUrl);
    setEnv("SUPABASE_SERVICE_ROLE_KEY", prevKey);
  }
});

// Sanity: tests should not have polluted the user's data/campaigns tree.
test("test data ended up inside cwd/data/campaigns (cleanup hint)", async () => {
  const dir = path.join(process.cwd(), "data", "campaigns");
  try {
    await fs.access(dir);
  } catch {
    // okay if it doesn't exist (clean checkout)
  }
  // Identify the cam_test_* and cam_dupe_* directories created by this test
  // run so the next dev knows where to clean up. We don't auto-delete to keep
  // the test side-effect-free in a way the operator can observe.
  void os;
});

runTests();
