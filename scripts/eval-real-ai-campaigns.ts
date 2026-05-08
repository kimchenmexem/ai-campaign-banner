#!/usr/bin/env tsx
/**
 * Step 11 — Visual AI Planner stress test.
 *
 * Generates N campaigns through planCampaign() against the real AI provider
 * (gpt-4o by default, anthropic if AI_PROVIDER=anthropic), then runs the
 * eval analyzer over the saved plans and writes a markdown report.
 *
 * Run with:
 *   npm run eval:real-ai                  # 20 campaigns, auto-detect provider
 *   npm run eval:real-ai -- --n=30        # 30 campaigns
 *   npm run eval:real-ai -- --provider=anthropic
 *   npm run eval:real-ai -- --provider=mock     # no API key required
 *
 * Outputs:
 *   data/eval-runs/<run_id>/report.md
 *   data/eval-runs/<run_id>/raw.json
 *   data/eval-runs/<run_id>/index.json   (campaign_id list)
 *
 * Notes:
 *   - When no API key is detected and --provider isn't set, falls back to
 *     mock with a clear note in the report. Mock returns the same 3 specs
 *     for every campaign — useful as a baseline but the metrics will show
 *     near-total mode collapse.
 *   - Doesn't render PNGs — eval is on the spec, not the pixel. Total
 *     runtime is ~5 min for 20 campaigns on gpt-4o (~$1.50 cost).
 *   - Brief library is intentionally varied (5 different goals × tones ×
 *     audiences) to surface AI behavior across the brief space.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { loadEnvLocalIfPresent } from "./_loadEnvLocal";
import { planCampaign } from "@/lib/ai/campaignPlanner";
import {
  CampaignBriefSchema,
  type CampaignBrief,
} from "@/lib/schemas/campaignBrief.schema";
import type { CampaignPlan } from "@/lib/schemas/aiCampaignPlan.schema";
import type { AIProviderName } from "@/lib/ai/provider";
import {
  analyzeCampaigns,
  renderMarkdownReport,
} from "@/lib/eval/analyzeCampaigns";

// ─── Brief library ───────────────────────────────────────────────────────────
// Varied along (campaign_goal, tone, target_audience, marketing_message,
// preferred_contexts) to stress the AI across the input space. Same brief
// gets cycled if N exceeds the library; the AI's seed-of-randomness comes
// from temperature, not from input variation alone, so duplicates still
// produce distinct campaigns.
const SAMPLE_BRIEFS: Array<Omit<CampaignBrief, "brief_id" | "created_at">> = [
  {
    brand_id: "brand_001",
    marketing_message: "Trade global markets with confidence",
    target_audience: "Self-directed retail traders, 25-55, comfortable with charts",
    campaign_goal: "consideration",
    tone: ["confident", "trustworthy", "premium"],
    platforms: ["instagram-feed", "linkedin"],
    required_formats: ["1200x628", "1080x1080", "1080x1920"],
    preferred_contexts: ["stocks", "etfs", "charts"],
    risk_warning_required: true,
    language: "en",
    creative_mode: "standard",
    notes: "Standard global-trading positioning.",
  },
  {
    brand_id: "brand_001",
    marketing_message: "Stop overpaying on ETF trades",
    target_audience: "Cost-conscious investors comparing brokers",
    campaign_goal: "conversion",
    tone: ["direct", "specific", "trustworthy"],
    platforms: ["instagram-feed"],
    required_formats: ["1200x628", "1080x1080", "1080x1920"],
    preferred_contexts: ["etfs", "general_platform"],
    risk_warning_required: true,
    language: "en",
    creative_mode: "standard",
    notes: "Lead with the cost-savings angle.",
  },
  {
    brand_id: "brand_001",
    marketing_message: "Real-time charts. Real-time decisions.",
    target_audience: "Active traders watching the market",
    campaign_goal: "consideration",
    tone: ["energetic", "alert", "precise"],
    platforms: ["linkedin", "instagram-story"],
    required_formats: ["1200x628", "1080x1080", "1080x1920"],
    preferred_contexts: ["charts", "stocks"],
    risk_warning_required: true,
    language: "en",
    creative_mode: "standard",
    notes: "Speed and immediacy.",
  },
  {
    brand_id: "brand_001",
    marketing_message: "150 markets. One login. Zero drift.",
    target_audience: "Globally-minded portfolio builders",
    campaign_goal: "awareness",
    tone: ["analytical", "premium", "trustworthy"],
    platforms: ["linkedin"],
    required_formats: ["1200x628", "1080x1080", "1080x1920"],
    preferred_contexts: ["general_platform", "etfs"],
    risk_warning_required: true,
    language: "en",
    creative_mode: "standard",
    notes: "Global access as the differentiator.",
  },
  {
    brand_id: "brand_001",
    marketing_message: "Margin rates most brokers hide",
    target_audience: "Sophisticated investors checking the fine print",
    campaign_goal: "conversion",
    tone: ["specific", "transparent", "confident"],
    platforms: ["linkedin"],
    required_formats: ["1200x628", "1080x1080", "1080x1920"],
    preferred_contexts: ["green_data", "general_platform"],
    risk_warning_required: true,
    language: "en",
    creative_mode: "standard",
    notes: "Transparency-led positioning.",
  },
];

function buildBrief(template: typeof SAMPLE_BRIEFS[number]): CampaignBrief {
  return CampaignBriefSchema.parse({
    ...template,
    brief_id: `brief_${crypto.randomBytes(6).toString("hex")}`,
    created_at: new Date().toISOString(),
  });
}

// ─── CLI parsing ─────────────────────────────────────────────────────────────

function parseFlag(name: string): string | undefined {
  const arg = process.argv.find((a) => a.startsWith(`${name}=`));
  return arg?.split("=").slice(1).join("=");
}

function pickProvider(): AIProviderName {
  const explicit = parseFlag("--provider");
  if (explicit === "openai" || explicit === "anthropic" || explicit === "mock") {
    return explicit;
  }
  // Auto-detect: prefer OpenAI if its key is set, then Anthropic, else mock.
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  return "mock";
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  await loadEnvLocalIfPresent();
  const N = Number(parseFlag("--n") ?? 20);
  const provider = pickProvider();
  const cwd = process.cwd();

  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const run_id = `eval_${provider}_${ts}`;
  const outDir = path.join(cwd, "data", "eval-runs", run_id);
  await fs.mkdir(outDir, { recursive: true });

  console.log(
    `[eval] Generating ${N} campaigns via provider=${provider}. Output: ${path.relative(cwd, outDir)}/`,
  );
  if (provider === "mock") {
    console.log(
      `[eval] WARNING: mock provider returns the same 3 specs for every campaign — metrics will show full mode collapse. Set OPENAI_API_KEY or pass --provider=openai for a real stress test.`,
    );
  }

  const plans: CampaignPlan[] = [];
  const failures: Array<{ brief: string; error: string }> = [];
  const startedAt = Date.now();

  for (let i = 0; i < N; i++) {
    const briefTemplate = SAMPLE_BRIEFS[i % SAMPLE_BRIEFS.length];
    const brief = buildBrief(briefTemplate);
    const briefLabel = briefTemplate.marketing_message.slice(0, 40);
    process.stdout.write(`[eval] ${i + 1}/${N} — "${briefLabel}…" `);
    try {
      const result = await planCampaign({
        brief,
        providerName: provider,
        setAsActive: false,
        cwd,
      });
      plans.push(result.plan);
      const downgrades = result.plan.warnings.filter((w) =>
        w.startsWith("downgrade: "),
      ).length;
      const conceptsWithSpec = result.plan.concepts.filter(
        (c) => c.visual_layout_spec,
      ).length;
      console.log(
        `→ ${result.plan.campaign_id} (specs=${conceptsWithSpec}/3, downgrades=${downgrades})`,
      );
    } catch (err) {
      const msg = (err as Error).message;
      console.log(`✗ FAILED: ${msg.slice(0, 80)}`);
      failures.push({ brief: briefLabel, error: msg });
    }
  }

  const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
  console.log(
    `[eval] Generated ${plans.length}/${N} campaigns in ${elapsedSec}s (${failures.length} failures).`,
  );

  // Index of campaign IDs so the user can inspect any of them.
  await fs.writeFile(
    path.join(outDir, "index.json"),
    JSON.stringify(
      {
        run_id,
        provider,
        generated_at: new Date().toISOString(),
        count: plans.length,
        failures,
        campaigns: plans.map((p) => ({
          campaign_id: p.campaign_id,
          campaign_name: p.campaign_name,
          warnings: p.warnings.length,
        })),
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  // Analyze + write report.
  const report = analyzeCampaigns(plans, { run_id, provider });
  await fs.writeFile(
    path.join(outDir, "raw.json"),
    JSON.stringify(report, null, 2) + "\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(outDir, "report.md"),
    renderMarkdownReport(report),
    "utf8",
  );

  console.log("");
  console.log(`[eval] Report: ${path.relative(cwd, outDir)}/report.md`);
  console.log(
    `[eval] Headlines: downgrades=${report.downgrades.total}, contradictions=${report.contradictions.total}, mode_collapse_mean=${report.mode_collapse.mean_collapse_score.toFixed(2)}, distinct_signatures=${report.cross_campaign_repetition.distinct_signatures}`,
  );
}

main().catch((err) => {
  console.error("[eval] Failed:", (err as Error).message);
  process.exit(1);
});
