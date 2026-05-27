/**
 * Local-dev fallback for fetchCampaignCopy.
 *
 * Used when MARKETING_TRANSLATOR_API_URL is unset, so engineers can iterate
 * on the banner pipeline without a running translator instance. The output
 * is deterministic but visibly mock-flavoured ("[mock] ...") so it never
 * gets confused with real localised copy in QA.
 */

import type {
  CampaignCopyBatchRequest,
  LocalizedCopyBatchResponse,
  CampaignCopyRequest,
  LocalizedCopyPackage,
} from "@/lib/marketing-translator/schema";

const RTL_PREFIX = ["he", "ar", "fa", "ur"];

function inferDirection(locale: string): "ltr" | "rtl" {
  const lower = locale.toLowerCase();
  return RTL_PREFIX.some((p) => lower.startsWith(p)) ? "rtl" : "ltr";
}

export function mockCampaignCopy(req: CampaignCopyRequest): LocalizedCopyPackage {
  const conceptName = req.conceptHint?.name ?? "default";
  const copy = pickPreviewCopy(req.brief.marketingMessage, conceptName, 0);

  return {
    locale: req.targetLocale,
    direction: inferDirection(req.targetLocale),
    headline: copy.headline,
    subheadline: copy.subheadline,
    body: copy.body,
    cta: copy.cta,
    disclaimer: req.riskWarningRequired === false
      ? "Terms apply."
      : copy.disclaimer,
    complianceNotes: ["local preview copy fallback used"],
  };
}

export function mockCampaignCopyBatch(
  req: CampaignCopyBatchRequest,
): LocalizedCopyBatchResponse {
  return {
    locale: req.targetLocale,
    direction: inferDirection(req.targetLocale),
    concepts: req.concepts.map((concept, index) => {
      const copy = pickPreviewCopy(
        req.brief.marketingMessage,
        concept.name ?? concept.conceptId,
        index,
      );
      return {
        conceptId: concept.conceptId,
        headline: copy.headline,
        subheadline: copy.subheadline,
        body: copy.body,
        cta: copy.cta,
        disclaimer: req.riskWarningRequired === false
          ? "Terms apply."
          : copy.disclaimer,
        complianceNotes: ["local preview copy fallback used"],
      };
    }),
  };
}

function pickPreviewCopy(
  marketingMessage: string,
  conceptName: string,
  index: number,
): {
  headline: string;
  subheadline: string;
  body: string;
  cta: string;
  disclaimer: string;
} {
  const concept = conceptName.toLowerCase();
  const message = marketingMessage.toLowerCase();
  const isTrading = /\b(trade|trading|markets?|invest|stocks?|etfs?)\b/.test(message);
  const tradingSet = [
    {
      match: /confidence|close|calm|authority/,
      headline: "Trade global markets with control",
      subheadline: "Advanced tools, real-time data and market access in one platform.",
      body: "A focused platform experience for investors who want depth without noise.",
      cta: "Explore platform",
      disclaimer: "Caution. Investing involves risk of loss.",
    },
    {
      match: /diversify|discipline|etf|balanced/,
      headline: "Build a broader market view",
      subheadline: "Compare instruments, follow data and act with a clearer picture.",
      body: "Bring stocks, ETFs and market insight into one disciplined workflow.",
      cta: "Compare markets",
      disclaimer: "Caution. Investing involves risk of loss.",
    },
    {
      match: /move|market|alert|focus|stocks?/,
      headline: "Move with real-time markets",
      subheadline: "Watch prices, charts and order tools work together in one flow.",
      body: "Designed for self-directed investors who follow the market closely.",
      cta: "View tools",
      disclaimer: "Caution. Investing involves risk of loss.",
    },
  ];
  const fallbackSet = [
    {
      match: /./,
      headline: titleCase(marketingMessage).slice(0, 58),
      subheadline: "A clear, focused message shaped for a premium campaign.",
      body: "A concise campaign concept for a polished brand execution.",
      cta: "Learn more",
      disclaimer: "Terms apply.",
    },
  ];
  const set = isTrading ? tradingSet : fallbackSet;
  return set.find((item) => item.match.test(concept)) ?? set[index % set.length];
}

function titleCase(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\b[a-z]/g, (m) => m.toUpperCase());
}
