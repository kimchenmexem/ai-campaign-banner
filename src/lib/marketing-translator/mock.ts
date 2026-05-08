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
