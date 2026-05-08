#!/usr/bin/env tsx
/**
 * Code-render every (concept × format) ad in a CampaignPlan via Playwright.
 * Falls back to demo when no campaign is specified or active.
 *
 * Run with:
 *   npm run render:code-campaign                       # active campaign
 *   npm run render:code-campaign -- --campaign-id=...  # explicit
 *   (no campaign found)                                # demo fallback
 *
 * The actual rendering is in src/lib/render/renderCampaign.ts so the same
 * logic is also reachable from /api/render-campaign (the "Render now" button
 * on the campaign detail page).
 *
 * Outputs:
 *   public/rendered-ads/campaigns/{campaign_id}/{concept_id}_{format}.png
 *   data/campaigns/{campaign_id}/code-render-map.generated.json
 *   data/campaigns/{campaign_id}/campaign.code-rendered.json
 */
import { loadEnvLocalIfPresent } from "./_loadEnvLocal";
import {
  loadActiveCampaignPointer,
  loadCampaignPlanIfExists,
} from "@/lib/ai/campaignPlanner";
import {
  renderCampaign,
  type CodeRenderRecord,
} from "@/lib/render/renderCampaign";

const DEFAULT_BASE_URL = process.env.RENDER_BASE_URL ?? "http://localhost:3000";
// Auto-probed when RENDER_BASE_URL is not set and `--base-url` not passed —
// catches the common case where `npm run dev` falls back to 3001/3002 because
// another process holds 3000.
const PROBE_PORTS = [3000, 3001, 3002, 3003] as const;
// Probe path that ONLY this project's Next server answers — keeps us from
// connecting to a leftover dev server of an unrelated project.
const PROBE_PATH = "/api/generators/registry";

async function main() {
  await loadEnvLocalIfPresent();
  const baseUrl = await resolveBaseUrl();
  const cliCampaignId = parseFlag("--campaign-id");

  const campaign_id =
    cliCampaignId ?? (await loadActiveCampaignPointer()) ?? null;

  if (campaign_id) {
    const plan = await loadCampaignPlanIfExists(campaign_id);
    if (!plan) {
      console.error(
        `✗ campaign ${campaign_id} not found at data/campaigns/${campaign_id}/`,
      );
      process.exit(2);
    }
    try {
      const result = await renderCampaign(plan, baseUrl, { onProgress: logRender });
      console.log("");
      console.log("Summary");
      console.log("─".repeat(60));
      console.log(`  campaign:  ${plan.campaign_id}`);
      console.log(`  total:     ${result.map.total}`);
      console.log(`  completed: ${result.map.completed}`);
      console.log(`  failed:    ${result.map.failed}`);
      console.log("");
      console.log(`✓ Wrote data/campaigns/${plan.campaign_id}/code-render-map.generated.json`);
      if (result.map.failed > 0) process.exitCode = 2;
    } catch (err) {
      console.error("render:code-campaign failed:", (err as Error).message);
      process.exit(1);
    }
    return;
  }

  // No active campaign → fall back to the demo.
  console.log(
    "· No active campaign found — falling back to demo (data/demo-campaign.preview.json).",
  );
  await renderDemoFallback(baseUrl);
}

async function renderDemoFallback(baseUrl: string): Promise<void> {
  console.log("· Running demo render path (RENDER_BASE_URL=" + baseUrl + ").");
  const { execSync } = await import("node:child_process");
  execSync(`RENDER_BASE_URL=${baseUrl} npx tsx scripts/render-code-demo.ts`, {
    stdio: "inherit",
  });
}

async function resolveBaseUrl(): Promise<string> {
  // Order: explicit --base-url=… > env RENDER_BASE_URL > auto-probe.
  const flag = process.argv.find((a) => a.startsWith("--base-url="));
  if (flag) return flag.slice("--base-url=".length);
  if (process.env.RENDER_BASE_URL) return process.env.RENDER_BASE_URL;
  // Try the default first, then walk the common alternates. Each probe
  // requires the response to look like THIS project (matches `ok:true` and
  // a `generators` key from /api/generators/registry).
  for (const port of PROBE_PORTS) {
    const candidate = `http://localhost:${port}`;
    if (await isOurNextServer(candidate)) {
      if (candidate !== DEFAULT_BASE_URL) {
        console.log(`· Auto-detected dev server at ${candidate}.`);
      }
      return candidate;
    }
  }
  // Falling through to the original default lets the existing
  // ensureBaseReachable error message surface.
  return DEFAULT_BASE_URL;
}

async function isOurNextServer(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(baseUrl + PROBE_PATH, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return false;
    const json = (await res.json()) as { ok?: boolean; generators?: unknown };
    return Boolean(json.ok && Array.isArray(json.generators));
  } catch {
    return false;
  }
}

function parseFlag(name: string): string | null {
  const f = process.argv.find((a) => a.startsWith(name + "="));
  return f ? f.slice(name.length + 1) : null;
}

function logRender(rec: CodeRenderRecord) {
  const tag = `[${rec.format}]`;
  if (rec.status === "completed") {
    const kb = rec.bytes ? `${(rec.bytes / 1024).toFixed(0)} KB` : "?";
    console.log(`${tag} ${rec.concept_id} ✓ ${rec.output_public_path} (${kb})`);
    for (const w of rec.warnings) console.log(`${tag}   ! ${w}`);
  } else {
    console.log(`${tag} ${rec.concept_id} ✗ ${rec.error ?? "unknown error"}`);
  }
}

main().catch((err) => {
  console.error("render:code-campaign failed:", (err as Error).message);
  process.exit(1);
});
