/**
 * Export gate — refuses to export a campaign ZIP when block-level QA
 * violations exist. Combines the cheap deterministic manifest checks with
 * any existing on-disk Vision QA report (we don't trigger Vision QA from
 * the gate; that's expensive and operator-initiated).
 *
 * The gate is advisory by default in the sense that callers must pass an
 * explicit `override=true` to proceed past blocks. This file deliberately
 * has no opinion on HTTP — the route handler is responsible for turning a
 * `blocked` result into a 409 response.
 */

import {
  runDeterministicQa,
  hasBlockingViolations,
  type DeterministicCampaignReport,
  type DeterministicViolation,
} from "@/lib/qa/deterministicQa";
import { loadCampaignVisionQa, type VisionQaMap } from "@/lib/qa/runQaForCampaign";
import type { CampaignPlan } from "@/lib/schemas/aiCampaignPlan.schema";

export interface BlockingReason {
  source: "deterministic" | "vision";
  ad_id: string;
  format: string;
  check_id: string;
  description: string;
  element_id?: string;
}

export interface ExportGateResult {
  blocked: boolean;
  override_applied: boolean;
  reasons: BlockingReason[];
  deterministic: DeterministicCampaignReport;
  vision: VisionQaMap | null;
}

export interface EvaluateExportGateOptions {
  plan: CampaignPlan;
  override: boolean;
  cwd?: string;
}

export async function evaluateExportGate(
  opts: EvaluateExportGateOptions,
): Promise<ExportGateResult> {
  return evaluateGate({ ...opts, adIdFilter: null });
}

export interface EvaluateAdExportGateOptions {
  plan: CampaignPlan;
  adId: string;
  override: boolean;
  cwd?: string;
}

/**
 * Per-ad variant for endpoints that export a single banner (e.g.
 * /api/export-ad-svg, /api/export-ad-elements). Reuses the same QA inputs
 * as `evaluateExportGate` but filters reasons to the supplied `adId` — a
 * clean banner can still be pulled while a sibling banner in the same
 * campaign has block-level violations. This preserves single-banner design
 * review without opening a bypass for bulk export of bad creative.
 */
export async function evaluateAdExportGate(
  opts: EvaluateAdExportGateOptions,
): Promise<ExportGateResult> {
  return evaluateGate({
    plan: opts.plan,
    override: opts.override,
    cwd: opts.cwd,
    adIdFilter: opts.adId,
  });
}

interface InternalGateOptions {
  plan: CampaignPlan;
  override: boolean;
  cwd?: string;
  adIdFilter: string | null;
}

async function evaluateGate(
  opts: InternalGateOptions,
): Promise<ExportGateResult> {
  const deterministic = runDeterministicQa(opts.plan);
  const vision = await loadCampaignVisionQa(
    opts.plan.campaign_id,
    opts.cwd,
  ).catch(() => null);

  const reasons: BlockingReason[] = [];
  if (hasBlockingViolations(deterministic)) {
    for (const b of deterministic.banners) {
      if (opts.adIdFilter !== null && b.ad_id !== opts.adIdFilter) continue;
      for (const v of b.violations) {
        if (v.severity !== "block") continue;
        reasons.push(detReason(b.ad_id, b.format, v));
      }
    }
  }
  if (vision) {
    for (const b of vision.banners) {
      if (opts.adIdFilter !== null && b.ad_id !== opts.adIdFilter) continue;
      for (const v of b.violations) {
        if (v.severity !== "block") continue;
        reasons.push({
          source: "vision",
          ad_id: b.ad_id,
          format: b.format,
          check_id: v.rule_id,
          description: v.description,
        });
      }
    }
  }

  const blocked = reasons.length > 0 && !opts.override;
  return {
    blocked,
    override_applied: reasons.length > 0 && opts.override,
    reasons,
    deterministic,
    vision,
  };
}

function detReason(
  adId: string,
  format: string,
  v: DeterministicViolation,
): BlockingReason {
  return {
    source: "deterministic",
    ad_id: adId,
    format,
    check_id: v.check_id,
    description: v.description,
    element_id: v.element_id,
  };
}
