// ─────────────────────────────────────────────────────────────────────────────
// Disclaimer topic detection.
//
// Each brand-kit `legal.topic_disclaimers` entry is appended to a campaign's
// general disclaimer when the campaign's copy mentions that topic. The match
// is keyword-based (no AI roundtrip): cheap, deterministic, easy to audit.
//
// Keywords are matched case-insensitive against the COMBINED text of the
// brief's marketing_message + brief.notes + concept.strategic_idea + the
// concept's copy_package (when available). Word boundaries (`\b`) keep
// short tokens like "tax" from matching "taxonomy".
//
// To extend: add a new TopicDisclaimer key in
// `src/lib/schemas/brandKit.schema.ts` (TopicDisclaimersSchema), add the
// English text to `brand-input/brand-spec/brand-spec.json` under
// `materials.disclaimer_or_risk_warnings.topic_disclaimers`, run
// `npm run brand:intake`, and add the keyword rule below.
// ─────────────────────────────────────────────────────────────────────────────

export type DisclaimerTopic = "etf_free" | "complex_products" | "tax_advice";

const TOPIC_PATTERNS: Record<DisclaimerTopic, RegExp> = {
  // ETFs / exchange-traded funds. Catches "ETF", "ETFs", "exchange-traded
  // fund(s)" with or without the hyphen.
  etf_free: /\b(etfs?|exchange[\s_-]?traded[\s_-]?funds?)\b/i,
  // Complex / leveraged products. Catches options, futures, warrants,
  // derivatives, plus the common shortcuts "leverage" / "leveraged".
  complex_products:
    /\b(option|options|future|futures|warrant|warrants|derivative|derivatives|leveraged?)\b/i,
  // Tax advice / taxation. Catches "tax", "taxes", "taxation" but NOT
  // "taxonomy" / "taxidermy" because of the `\b` boundary on the trailing
  // side.
  tax_advice: /\b(tax|taxes|taxation)\b/i,
};

/**
 * Returns the list of topic keys whose keywords appear in the input text.
 * Order is stable across the TopicDisclaimers fields so the assembled
 * disclaimer string is deterministic.
 */
export function detectDisclaimerTopics(text: string): DisclaimerTopic[] {
  if (!text) return [];
  const topics: DisclaimerTopic[] = [];
  for (const topic of ["etf_free", "complex_products", "tax_advice"] as const) {
    if (TOPIC_PATTERNS[topic].test(text)) topics.push(topic);
  }
  return topics;
}

/**
 * Assemble the final disclaimer: general (already-translated) text, plus
 * any matching topic appendices joined with a single space.
 *
 * `topicTexts` is the brand-kit `legal.topic_disclaimers` block. Missing
 * entries (a topic that matched the keyword but has no brand-kit text) are
 * skipped silently rather than erroring — the keyword detection is a
 * "consider this disclaimer" signal; the brand kit ultimately decides
 * which appendices are available.
 */
export function appendTopicDisclaimers(
  generalDisclaimer: string,
  text: string,
  topicTexts: Partial<Record<DisclaimerTopic, string | undefined>> | undefined,
): string {
  if (!topicTexts) return generalDisclaimer;
  const matched = detectDisclaimerTopics(text);
  const appendix = matched
    .map((t) => topicTexts[t])
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join(" ");
  if (!appendix) return generalDisclaimer;
  if (!generalDisclaimer) return appendix;
  return `${generalDisclaimer.trimEnd()} ${appendix}`;
}
