/**
 * Local-dev fallback for fetchCampaignCopy.
 *
 * Used when MARKETING_TRANSLATOR_API_URL is unset, so engineers can iterate
 * on the banner pipeline without a running translator instance. The output
 * is deterministic but visibly mock-flavoured ("[mock] ...") so it never
 * gets confused with real localised copy in QA.
 */

import type {
  CampaignCopyRequest,
  CampaignCopyBatchRequest,
  CampaignCopyBatchResponse,
  LocalizedCopyPackage,
} from "@/lib/marketing-translator/schema";

const RTL_PREFIX = ["he", "ar", "fa", "ur"];

function inferDirection(locale: string): "ltr" | "rtl" {
  const lower = locale.toLowerCase();
  return RTL_PREFIX.some((p) => lower.startsWith(p)) ? "rtl" : "ltr";
}

export function mockCampaignCopy(req: CampaignCopyRequest): LocalizedCopyPackage {
  const tone = Array.isArray(req.tone) ? req.tone.join("/") : req.tone;
  const conceptName = req.conceptHint?.name ?? "default";
  const message = req.brief.marketingMessage.slice(0, 80);

  return {
    locale: req.targetLocale,
    direction: inferDirection(req.targetLocale),
    headline: `[mock ${req.targetLocale}] ${message}`,
    subheadline: `[mock ${req.targetLocale}] ${tone} • ${conceptName}`,
    body: `[mock ${req.targetLocale}] ${req.brief.campaignGoal} narrative for ${conceptName}.`,
    cta: `[mock] Learn more`,
    disclaimer: req.riskWarningRequired === false
      ? `[mock disclaimer]`
      : `[mock disclaimer] Capital at risk.`,
    complianceNotes: [],
  };
}

// Batch mock: gives each concept a distinct CTA verb so dev-mode mock copy
// looks plausibly like a real campaign (vs three identical "Learn more"s).
const MOCK_CTA_VERBS = ["Learn more", "Get started", "Explore", "Compare", "Discover", "See plans"];

export function mockCampaignCopyBatch(req: CampaignCopyBatchRequest): CampaignCopyBatchResponse {
  const tone = Array.isArray(req.tone) ? req.tone.join("/") : req.tone;
  const message = req.brief.marketingMessage.slice(0, 80);
  return {
    locale: req.targetLocale,
    direction: inferDirection(req.targetLocale),
    concepts: req.concepts.map((c, i) => ({
      conceptId: c.conceptId,
      headline: `[mock ${req.targetLocale}] ${c.name ?? "concept " + (i + 1)}: ${message}`,
      subheadline: `[mock ${req.targetLocale}] ${tone} • ${c.strategicIdea?.slice(0, 60) ?? c.name ?? "concept " + (i + 1)}`,
      body: `[mock ${req.targetLocale}] ${req.brief.campaignGoal} narrative for ${c.name ?? "concept " + (i + 1)}.`,
      cta: `[mock] ${MOCK_CTA_VERBS[i % MOCK_CTA_VERBS.length]}`,
      disclaimer: req.riskWarningRequired === false
        ? `[mock disclaimer]`
        : `[mock disclaimer] Capital at risk.`,
      complianceNotes: [],
    })),
  };
}
