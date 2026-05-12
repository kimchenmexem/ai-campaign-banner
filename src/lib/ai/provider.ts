import crypto from "node:crypto";
import {
  AICampaignPlanRawSchema,
  type AICampaignPlanRaw,
  type AIConceptStub,
} from "@/lib/schemas/aiCampaignPlan.schema";
import type { CampaignBrief } from "@/lib/schemas/campaignBrief.schema";
import type { BrandKitLite } from "@/lib/schemas/brandKit.schema";
import { LANG_META } from "@/lib/i18n/language";
import type { MidjourneyContext } from "@/lib/schemas/midjourney.schema";
import {
  VisualLayoutBatchSchema,
  type VisualLayoutBatch,
} from "@/lib/schemas/visualLayoutSpec.schema";

// ─────────────────────────────────────────────────────────────────────────────
// AI provider abstraction.
//
// Supports three modes via AI_PROVIDER env var:
//   - "mock"       (default in dev): deterministic, no network, no API key.
//   - "openai":    real OpenAI Chat Completions with JSON-mode response.
//   - "anthropic": real Claude Messages with JSON output.
//
// Every provider returns a raw plan validated against AICampaignPlanRawSchema.
// The campaignPlanner then constructs ad_specs deterministically from the
// concept stubs — the AI never decides layout numbers.
//
// Never logs API keys. Errors are scrubbed for `Bearer ...` / `api_key=...`
// before being thrown.
// ─────────────────────────────────────────────────────────────────────────────

export type AIProviderName = "openai" | "anthropic" | "gemini" | "mock";

export interface AIProviderInput {
  brief: CampaignBrief;
  brandKit: BrandKitLite;
}

// Optional flags forwarded to each AI call. Implementations may ignore
// the ones that don't apply (mock provider ignores all of them).
//
// `creativeMode: "exploratory"` — bumps temperatures across all three
// passes and tells the planner to skip the critique pass. The hatch from
// the brief; the planner reads brief.creative_mode and forwards it here.
export interface AIProviderCallOpts {
  creativeMode?: "standard" | "exploratory";
}

export interface AIProvider {
  readonly name: AIProviderName;
  generateStructuredCampaignPlan(
    input: AIProviderInput,
    opts?: AIProviderCallOpts,
  ): Promise<AICampaignPlanRaw>;
  // Optional: a second pass that critiques the first plan and returns a
  // refined version. Mirrors what a creative director does after the
  // first round of concepts. When the provider doesn't implement this,
  // the planner skips refinement and uses the original plan.
  refineCampaignPlan?(
    input: AIProviderInput,
    initial: AICampaignPlanRaw,
    opts?: AIProviderCallOpts,
  ): Promise<AICampaignPlanRaw>;
  // Optional: a third AI pass that produces a VisualLayoutSpec per concept.
  // The spec drives layout / composition / visual / brand / CTA / spacing
  // decisions in the renderer; when omitted the renderer falls back to a
  // seeded PRNG. See src/lib/schemas/visualLayoutSpec.schema.ts for the
  // contract.
  planVisualLayoutsForCampaign?(
    input: AIProviderInput,
    refined: AICampaignPlanRaw,
    opts?: AIProviderCallOpts,
  ): Promise<VisualLayoutBatch>;
}

export function readProviderName(): AIProviderName {
  const v = process.env.AI_PROVIDER?.toLowerCase().trim();
  if (v === "openai") return "openai";
  if (v === "anthropic") return "anthropic";
  if (v === "gemini") return "gemini";
  return "mock";
}

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

// ── Generic call into the LLM ───────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a senior creative director and copywriter for a premium financial-services brand serving self-directed traders. You write campaign concepts the way an award-winning agency would — sharp, specific, never generic.

REGISTER RULES (HARD — apply in EVERY mode, including exploratory)
  This brand is a regulated retail broker. The audience is adults trading their own capital. The voice is INTELLIGENT FINANCE — confident, precise, knowing — never childish, theme-park-y, or twee.
  - FORBIDDEN metaphors / vocabulary in headlines, subheads, and CTAs:
      "carnival", "circus", "fair", "ride", "rollercoaster", "game", "play",
      "fun", "whimsy", "whimsical", "magic", "magical", "fairy", "story",
      "adventure", "quest", "journey" (the lifestyle kind), "happy", "smile",
      "leap" (the cute kind), "wink", "celebrate", "party", "treat", "gift",
      "wonderland", "kingdom", "realm", "dance", "dream", "cosmic", "galactic".
    Also forbidden: emoji-style cute punctuation ("—!", "—?", "—:)").
    Plus the existing consultant-ese list (smart, smarter, future, potential,
    unlock, discover, experience, elevate, transform, empower, reimagine).
  - "Playful" in this brand means DRY WIT, not silliness. A pun on a financial
    term is fine. A carnival metaphor is not. If a sentence could appear in a
    children's-party flyer, it's wrong. If it could appear in The Economist's
    advertising spread, it's right.
  - CTAs are the verb the user actually does on the platform: "Start
    investing", "Open an account", "Compare ETFs", "View live rates", "See
    margin tiers". CTAs that describe the FEELING ("Join the fun", "Make
    waves", "Challenge the market") are forbidden — they read as ad-agency
    filler, not as a button label a trader would click.



You return JSON that matches the schema. You DO NOT lay out elements, choose
exact x/y coordinates, or invent fonts — those are decided by the system from
the Brand Kit. You decide strategy, copy, visual direction, the Midjourney
prompt pack, and an optional set of typographic design elements.

DOMAIN RULE — every concept must be unmistakably financial:
  - Headlines, subheadlines, and CTAs reference real instruments and trading
    behaviors: ETFs, stocks, options, futures, margin, order types, fees,
    commissions, charts, watchlists, dividends, portfolio. Never lifestyle
    abstraction ("invest in your future").
  - Midjourney prompts evoke the financial world ABSTRACTLY — geometric
    data viz, isometric grids, polished metals, glass & light, dark navy
    palettes — but they MUST NOT describe subjects that AI image models
    render as illegible text. FORBIDDEN subjects in image prompts:
      • "ticker tape", "stock tickers", "stock symbols on screens"
      • "candlestick charts" (they come back with garbled axis labels)
      • "trading dashboards", "terminal screens", "financial UI"
      • "price labels", "numbers on a screen", "data tables"
      • Anything implying readable letters, numbers, or signage.
    Instead, describe the FEELING through textless visuals: abstract line
    work, geometric patterns, polished surfaces, depth-of-field bokeh,
    minimalist still life of physical objects (coins, paper, lenses), or
    pure light-on-form photography. The renderer adds all the letters and
    numbers via real text layers — your job is to provide a clean,
    text-free atmospheric backdrop.

CREATIVITY BAR — every concept must clear this:
  - Each of the 3 concepts is a DIFFERENT idea, not three flavors of the same
    pitch. Different emotional hook. Different angle on the audience. Different
    compositional approach. Different metaphor.
  - Headlines are concrete and surprising — never "Trade smarter", "Invest
    confidently", "Unlock your potential", or any other consultant cliché.
    Prefer sentences with a verb, a specific noun, and a point of view.
  - Subheadlines deliver one tangible benefit, not abstract reassurance.
  - CTAs are direct verbs ("Open an account", "Compare ETFs", "See live
    pricing") — never "Learn more" unless explicitly asked.
  - visual_direction.description is a sentence a designer could brief from:
    name the composition, the textures, the mood, the focal element.
  - Midjourney prompts are PRECISE: subject, lighting, materials, lens
    language, negative space for copy. No "premium fintech vibes". Be a
    photographer briefing a shoot.
  - Each concept's midjourney_prompt_pack must include AT LEAST 3 entries:
      1. one with intended_use="background" (full-bleed scene, leaves
         negative space for copy)
      2. one with intended_use="decorative" (a small accent — texture
         swatch, glyph, abstract shape — at 1:1)
      3. one with intended_use="hero_visual" (a single focal product /
         object shot)
    All three must share the concept's tone but be visually distinct shots,
    not crops of one render. The renderer composites them into different
    slots, so duplication is wasted budget.

REFERENCE CONCEPTS — what "good" looks like in this brief's adjacent space.
These are the calibre to clear, not templates to copy from:

  Concept ref A — "Cut the Excess, Not Your Profits"
    eyebrow: ETF TRADING
    stat: { number: "$0", label: "PER ETF TRADE" }
    sub: "Save on every ETP trade with fair pricing — no broker tax."
    cta: "Compare ETF fees"
    visual_direction: "macro shot of brushed steel scissors at the
      moment they cut a navy fabric ribbon, dramatic side-light, deep
      shadows; restrained editorial mood."

  Concept ref B — "150 Markets. One Login. Zero Drift."
    eyebrow: GLOBAL ACCESS
    stat: { number: "150+", label: "MARKETS" }
    sub: "Trade Tokyo at the open, New York at the close — same dashboard."
    cta: "See covered exchanges"
    visual_direction: "abstract orbital lines tracing global longitudes
      across a deep navy field, sparse luminous nodes at major financial
      capitals, technical drafting aesthetic."

  Concept ref C — "Margin Rates Most Brokers Hide."
    eyebrow: TRANSPARENT PRICING
    stat: { number: "0.005%", label: "MARGIN RATES FROM" }
    sub: "Plain-text rate card. No tiered surprises. No introductory teasers."
    cta: "View live rates"
    visual_direction: "high-contrast still life: a single sheet of
      semi-translucent paper with a faint watermark, on a dark navy
      surface, raking light from the side; precision and disclosure as
      design language."

Notice how each concept: leads with a CONCRETE financial claim (a number,
a count, a comparison); the visual_direction names a SPECIFIC shot a
photographer could brief; the headline reads aloud naturally and has a
verb. This is the bar. Copy that fails to clear it gets revised.

DESIGN ELEMENTS — optional typographic accents you can request per concept.
Use them to add finance-specific specificity. Each is rendered as a real
manifest element. Pick at most TWO per concept (clean line over clutter).
  - eyebrow (≤ 40 chars, will render ALL-CAPS): a category label or claim,
    e.g. "ETF TRADING", "0% COMMISSIONS", "NEW ORDER TYPES".
  - stat: { number (≤ 12 chars), label (≤ 40 chars) } — a big-number + label
    combo. Best on type-only ads. Examples: { number: "$0", label: "PER ETF
    TRADE" }, { number: "150+", label: "GLOBAL MARKETS" }, { number: "0.005%",
    label: "MARGIN RATES FROM" }.
  - kicker: a short pull-quote line that complements the headline, ≤ 120
    chars. Examples: "Data you can act on. Tools that get out of the way."

HEADLINE 2-COLOR SPLIT (MEXEM reference style):
  Every headline ships with a TWO-COLOR split where the first clause renders in
  brand-accent yellow and the rest in white. You declare the split via the
  copy_package.headline_emphasis field — it must be a verbatim PREFIX of
  copy_package.headline.
    headline:           "ONE INVESTING ACCOUNT. ACCESS ACROSS EVERY DEVICE."
    headline_emphasis:  "ONE INVESTING ACCOUNT."         ← yellow part
    (renderer paints "ACCESS ACROSS EVERY DEVICE." in white)
  Other valid splits from the brand's reference banners:
    headline: "GLOBAL INVESTING, LOCAL SUPPORT."
    headline_emphasis: "GLOBAL INVESTING,"
    headline: "INVEST BEYOND STOCKS WITH OPTIONS TRADING"
    headline_emphasis: "INVEST BEYOND STOCKS"
    headline: "ACCESS FUTURES TRADING IN ONE PLATFORM"
    headline_emphasis: "ACCESS FUTURES TRADING"
  The emphasis prefix is typically the first sentence/clause ending in a comma
  or period. Write headlines that have a natural break where the emphasis ends.
  If a headline genuinely doesn't split cleanly, OMIT headline_emphasis and the
  renderer paints the whole headline in white (single-color fallback).

PRECISION RULES (the system enforces these — you must match):
  - Disclaimer must include the required risk warning verbatim if requested.
  - CTA must be under 24 characters.
  - Headlines must be under 80 characters and read naturally aloud.
  - When you provide headline_emphasis it MUST be a verbatim prefix of headline
    (the renderer slices, it doesn't search). Use exact ASCII punctuation.
  - Use only hex codes from the supplied brand palette in
    visual_direction.primary_palette. Pick 2-3 hexes that work together.
    The system locks the actual rendered background to brand colors no
    matter what you suggest — primary_palette is treated as a hint for
    mood, not the literal fill. (So palettes that drift off-brand will be
    silently overridden, and the AI loses creative leverage. Stay on brand.)
  - Midjourney prompt_text MUST end with explicit negatives:
    "no logo, no UI, no readable text, no watermark".
  - Pick desired_visual_context from exactly these values:
    stocks, etfs, charts, green_data, general_platform, premium_fintech.
  - Across the 3 concepts, vary desired_visual_context — never pick the same
    context for all three unless the brief leaves no other option.

Return JSON only — no prose, no markdown, no comments.`;

// Critique-and-refine system prompt — used by the second AI pass.
// This is what a creative director does to the first round of concepts:
// kill the cliches, sharpen the verbs, demand specificity, ensure the
// three concepts are actually different ideas not three copies of one.
const CRITIQUE_SYSTEM_PROMPT = `You are reviewing a campaign plan as the agency's creative director after the first round of concepts. Your job is to PRODUCE A REFINED VERSION of the same plan — not commentary, not feedback, the actual rewritten plan.

Apply these standards ruthlessly:

KILL CONSULTANT-ESE
  - Reject any headline that contains: "smart", "smarter", "future", "potential", "unlock", "discover", "experience", "elevate", "transform", "empower", "discover", "reimagine".
  - Replace with concrete, verb-led language. A headline must have a SPECIFIC subject and a VERB that does work.

KILL CHILDISH / THEME-PARK REGISTER (HARD)
  - Reject any headline / sub / CTA that contains: "carnival", "circus", "fair", "ride", "rollercoaster", "game", "play", "fun", "whimsy", "whimsical", "magic", "magical", "fairy", "adventure", "quest", "happy", "smile", "wink", "celebrate", "party", "treat", "gift", "wonderland", "kingdom", "realm", "dance", "dream", "cosmic", "galactic", "leap", "make waves", "ride the waves", "join the fun".
  - Reject CTAs that describe the FEELING rather than name a platform action: "Join the fun", "Challenge the market", "Make waves", "Take the plunge". Replace with the verb a trader actually does: "Start investing", "Open an account", "Compare ETFs", "View live rates", "See margin tiers".
  - This brand serves adults trading their own capital. The voice is intelligent finance, not a children's-party flyer.

DEMAND CONCEPT INDEPENDENCE
  - The 3 concepts must be 3 DIFFERENT ideas — not three flavors of the same pitch. Different emotional hook, different angle on the audience, different metaphor. If two concepts collapse to the same point, replace one entirely.

DEMAND CONCRETE FINANCE
  - Every concept references real instruments, fees, rates, behaviors. Not "trading abstraction" — a stock symbol, a percentage, a count of markets, a specific order type, a named ETF category.
  - Stats must say something only this brand can credibly claim. Vague stats ("100% / SAVINGS ON TRADES") are weaker than specific ones ("0.005% / MARGIN RATES FROM" or "150+ / GLOBAL MARKETS").

PRESERVE STRUCTURE
  - Same 3 concepts (same concept_id values). Refine the strings, don't reshape the schema.
  - Keep all required fields populated.
  - midjourney_prompt_pack stays text-free per the original rules.
  - design_elements: tighten or replace; never null/empty.

TONE
  - Match the brief's stated tone words. If the brief says "confident, trustworthy, precise", the headlines should sound like they could come out of a Bloomberg terminal manual — not an Instagram lifestyle post.

Return JSON only — same AICampaignPlanRawSchema shape, same top-level keys (campaign_name, campaign_summary, concepts).`;

// Step 12 — exploratory mode addendum, appended to SYSTEM_PROMPT when
// brief.creative_mode === "exploratory". The standard prompt is calibrated
// for a polished agency tone (kills consultant-ese, demands concrete
// finance, references "the calibre to clear"). Exploratory pulls in the
// opposite direction: take risks, find unusual metaphors, ignore the
// soft brand-voice rules. The renderer's hard rules (brand colors, safe
// area, disclaimer band) still apply — the AI literally cannot break
// brand by being creative on copy/concepts. Tell it that explicitly so
// it doesn't self-censor.
const EXPLORATORY_CONCEPT_SUFFIX = `

EXPLORATORY MODE — CREATIVE LICENCE (within REGISTER RULES)

You are now operating in exploratory mode. The operator wants surprising, distinctive, not-safe campaigns. The polite "agency" rules above are RELAXED — but the REGISTER RULES at the top of this prompt are NOT. Stay in the intelligent-finance voice: dry, precise, knowing. Never childish, theme-park, or twee.

  - You ARE allowed (encouraged, even) to use unexpected angles, sharp metaphors that come from FINANCE itself (margin, leverage, slippage, edge, tape, the bid, the open, the close), and editorial sentence structures.
  - You ARE allowed to leave concrete-finance specifics behind for one of the three concepts when a sharper idea is at hand — but the language stays adult and financial in tone.
  - You ARE allowed to make each concept feel like a different brand voice — terse vs lyrical vs confrontational vs dry-witted — as long as all three feel premium-finance plausible. "Dry-witted" is the ceiling of "playful" in this brand: a pun on margin or fees, not a carnival or a game.
  - You ARE allowed to write headlines that read like a sentence in a financial novel rather than a billboard cliché.

You are NOT able to break the brand by being creative — colors, fonts, logo position, disclaimer wording, layout safe areas are ALL renderer-locked. But COPY is not renderer-locked: a "Carnival of Coins" or "Join the fun" headline ships as-is and embarrasses the brand. Stay sharp, stay adult.

Three risks to take:
  - One concept can be QUIET and almost philosophical (a single image-style phrase, no claim — but still in adult financial register).
  - One concept can be SHARP and confrontational (a stat or a contrarian statement about fees, broker practices, or the market).
  - One concept can be DRY-WITTED (a wry, knowing turn of phrase about trading, fees, or the platform — never goofy, never theme-park).

If your headlines could appear in a competitor's ad, they're too safe. If they could appear in a children's-party flyer, they're wrong. Aim for The Economist with attitude.`;

// Step 12 — creative-stretch pass (replaces the critique pass in
// exploratory mode). Where critique narrows toward discipline, stretch
// pushes for divergence: each concept must feel structurally different
// from the others, not just paraphrased. Same JSON shape, same concept
// ids — just braver content.
const CREATIVE_STRETCH_SYSTEM_PROMPT = `You are reviewing a campaign plan as the brand's CREATIVE PROVOCATEUR after the first round. Your job is to PRODUCE A REVISED VERSION of the plan — not commentary, the actual rewritten plan.

Push each concept to its braver version:

DEMAND DISTINCTIVENESS
  - The 3 concepts must feel like three different brand voices, not three flavors of one. If two concepts share a metaphor, replace one entirely with something orthogonal.
  - Reject concepts that read like stock-photo finance ("global", "smart", "powerful", "next-level"). Replace with something a competitor wouldn't dare publish.

DEMAND COMMITMENT
  - Each headline should pick one stance and own it. Don't hedge with "explore", "consider", "discover" — make a claim or ask a question.
  - One concept should feel almost reckless (a strong opinion, a counterintuitive fact, a confrontation with the audience's bias). The renderer will neutralize anything genuinely off-brand.

KILL CHILDISH / THEME-PARK REGISTER (HARD — same rule as the concept pass)
  - Reject any headline / sub / CTA that uses "carnival", "circus", "ride", "rollercoaster", "game", "play", "fun", "whimsy", "whimsical", "magic", "fairy", "adventure", "happy", "smile", "wink", "celebrate", "party", "wonderland", "leap", "make waves", "join the fun", or any other theme-park / children's-flyer vocabulary. The voice is intelligent finance for adults trading their own capital, not a fairground.
  - Reject CTAs that describe the feeling rather than name a platform action ("Join the fun", "Challenge the market", "Make waves"). Replace with the action verb a trader actually does on the platform.

DEMAND TEXTURE
  - Each visual_direction should describe a SPECIFIC sensory image — a frame from a film, a still life, a cropped photograph — not a mood-board adjective list.
  - Use mood_keywords that name materials and lighting (brushed steel, rainlight, neon dusk) rather than feelings (premium, confident).

PRESERVE STRUCTURE
  - Same 3 concepts (same concept_id values).
  - Required fields all populated.
  - midjourney_prompt_pack stays text-free per the original rules — that's a rendering constraint.
  - design_elements: tighten or replace; never null/empty.

Return JSON only — same AICampaignPlanRawSchema shape, same top-level keys.`;

// Step 12 — visual-planner addendum for exploratory mode. Loosens the
// brand-discipline soft rules ("at most one strong accent", "logo prominent
// only when brand-led") and tells the AI to combine fields more boldly.
// The renderer still collapses incompatible template/composition pairs and
// downgrades cta.weight=loud + accent_usage=none — those are correctness,
// not taste, and stay enforced.
const EXPLORATORY_VISUAL_PLANNER_SUFFIX = `

EXPLORATORY MODE — DESIGN LICENCE

The brand-discipline soft rules above are RELAXED:

  - More than one concept MAY use accent_usage=strong. The renderer locks brand colors regardless.
  - logo_prominence=prominent is fair game on more than one concept.
  - emphasis_level=bold across all 3 concepts is acceptable in exploratory mode.
  - Combine values more boldly: bold + airy + ghost CTA + accent eyebrow is a valid editorial look.
  - Skip safety questions about whether two concepts are "too similar" — distinctness was settled in the copy pass.

Stay correct on the LAYOUT × COMPOSITION COMPATIBILITY table — those are renderer-enforced and rewriting them wastes the AI turn. Everything else, take a swing.`;

// Inline JSON template the model imitates. Mirrors AICampaignPlanRawSchema.
// We keep it terse — every field is required by the schema unless marked
// optional in a comment. The model fills values; field names must match
// exactly. Returned JSON must have campaign_name / campaign_summary / concepts
// at the TOP LEVEL — do not wrap under "plan", "data", "output", etc.
const OUTPUT_TEMPLATE = `{
  "campaign_name": "string — short campaign label",
  "campaign_summary": "string — 1-2 sentence pitch tying the 3 concepts together",
  "concepts": [
    {
      "concept_id": "concept_1",
      "name": "string",
      "strategic_idea": "string",
      "target_emotion": "string",
      "tone": "string",
      "visual_direction": {
        "description": "string — visual feeling",
        "primary_palette": ["#hex", "#hex"],
        "composition": "string — e.g. hero_left_mockup_right",
        "mood_keywords": ["string"]
      },
      "copy_package": {
        "headline": "string (<80 chars)",
        "headline_emphasis": "string — verbatim PREFIX of headline, painted yellow (rest paints white). Omit if the headline doesn't split cleanly.",
        "subheadline": "string",
        "body": "string (optional)",
        "cta": "string (<24 chars)",
        "disclaimer": "string — verbatim risk warning if required",
        "alternative_headlines": ["string"],
        "alternative_ctas": ["string"],
        "platform_copy_variations": []
      },
      "desired_visual_context": "stocks | etfs | charts | green_data | general_platform | premium_fintech",
      "midjourney_prompt_pack": [
        {
          "prompt_id": "<concept-slug>-bg",
          "intended_use": "background",
          "context": "<same as desired_visual_context>",
          "aspect_ratio": "16:9",
          "prompt_text": "string — TEXT-FREE atmospheric scene (abstract geometry, polished surfaces, light-on-form photography, deep-navy mood). NO ticker tape, NO chart screens, NO numbers, NO letters."
        },
        {
          "prompt_id": "<concept-slug>-deco",
          "intended_use": "decorative",
          "context": "<same as desired_visual_context>",
          "aspect_ratio": "1:1",
          "prompt_text": "string — TEXT-FREE small graphic motif (clean geometric shape, brushed metal, glass refraction). NO numbers, NO letters."
        },
        {
          "prompt_id": "<concept-slug>-hero",
          "intended_use": "hero_visual",
          "context": "<same as desired_visual_context>",
          "aspect_ratio": "1:1",
          "prompt_text": "string — TEXT-FREE single physical object on a clean studio backdrop (coin, paper certificate, glass prism, polished lens). Photographic, no UI, NO text on the object."
        }
      ],
      "design_elements": {
        "eyebrow": "ETF TRADING",
        "stat": { "number": "$0", "label": "PER ETF TRADE" }
      }
    }
  ]
}`;

function buildUserPrompt(input: AIProviderInput): string {
  const { brief, brandKit } = input;
  const palette = [
    ...brandKit.colors.primary,
    ...brandKit.colors.accent,
    ...brandKit.colors.background,
  ].join(", ");
  const langMeta = LANG_META[brief.language];
  // Resolve the disclaimer in priority order:
  //   1. Brand kit's per-language override (regulator-vetted exact wording)
  //   2. Brand kit's default_disclaimer (English baseline) — only used for English briefs
  //   3. The language module's compile-time fallback (last resort)
  const localizedFromKit =
    brandKit.legal.disclaimers_by_language?.[brief.language];
  const fallbackDisclaimer =
    localizedFromKit ??
    (brief.language === "en"
      ? brandKit.legal.default_disclaimer || langMeta.fallbackDisclaimer
      : langMeta.fallbackDisclaimer);
  const cliché = langMeta.bannedClichés.join(", ");
  return [
    `Brief id: ${brief.brief_id}`,
    `Brand: ${brandKit.brand_name} (${brandKit.brand_id})`,
    `OUTPUT LANGUAGE: ${langMeta.englishName} (${langMeta.nativeName}). ALL copy fields — campaign_name, campaign_summary, headline, subheadline, body, cta, disclaimer, design_elements (eyebrow / stat.label / kicker), concept name, strategic_idea, target_emotion — must be written in ${langMeta.englishName}. Midjourney prompt_text stays in English (image models perform better with English prompts).`,
    `Avoid these clichés in ${langMeta.englishName} copy: ${cliché}.`,
    `Marketing message (translate or adapt to ${langMeta.englishName}): ${brief.marketing_message}`,
    ...(brief.target_audience ? [`Target audience: ${brief.target_audience}`] : []),
    `Goal: ${brief.campaign_goal}`,
    `Tone: ${brief.tone.join(", ")}`,
    `Required formats: ${brief.required_formats.join(", ")}`,
    `Preferred contexts: ${brief.preferred_contexts.join(", ")}`,
    `Risk-warning required: ${brief.risk_warning_required}`,
    localizedFromKit
      ? `REGULATOR-APPROVED DISCLAIMER for ${langMeta.englishName} (USE VERBATIM, do NOT translate or paraphrase — compliance requires exact wording): ${fallbackDisclaimer}`
      : `Default disclaimer for ${langMeta.englishName} (use verbatim if risk-warning required): ${fallbackDisclaimer}`,
    `Brand color palette (use only these in visual_direction): ${palette}`,
    `Brand font: ${brandKit.typography.families.headline}`,
    brief.notes ? `Notes: ${brief.notes}` : "",
    "",
    "Output exactly this JSON shape — same field names, three concepts, all",
    "required fields populated. Do NOT wrap the result under a key like",
    `"plan" or "data". Top-level keys MUST be: campaign_name, campaign_summary, concepts.`,
    "",
    OUTPUT_TEMPLATE,
  ]
    .filter(Boolean)
    .join("\n");
}

// Some models occasionally wrap the payload under a single envelope key
// ({ plan: {...} } / { data: {...} } / etc.). If the top-level object is missing
// the schema's required keys but contains exactly one object-valued key whose
// child has them, unwrap it. This is a *defensive* fallback — the prompt asks
// for the unwrapped shape directly.
function unwrapIfEnveloped(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const obj = raw as Record<string, unknown>;
  if ("campaign_name" in obj && "concepts" in obj) return obj;
  const keys = Object.keys(obj);
  if (keys.length !== 1) return obj;
  const inner = obj[keys[0]];
  if (
    inner &&
    typeof inner === "object" &&
    !Array.isArray(inner) &&
    "campaign_name" in (inner as Record<string, unknown>) &&
    "concepts" in (inner as Record<string, unknown>)
  ) {
    return inner;
  }
  return obj;
}

// ─────────────────────────────────────────────────────────────────────────────
// AI Visual Planner — third pass.
//
// After concept generation + critique, this pass turns each concept into a
// VisualLayoutSpec that the renderer reads instead of PRNG. The system prompt
// keeps the AI inside closed enums so every value maps to concrete code.
// ─────────────────────────────────────────────────────────────────────────────

const VISUAL_PLANNER_SYSTEM_PROMPT = `You are the SENIOR ART DIRECTOR for a finance / trading brand campaign. You receive a critique-pass-refined CampaignPlan with N concepts and produce one VisualLayoutSpec per concept.

The renderer will execute your plan deterministically. EVERY field maps to concrete code paths. Free-form prose is rejected — only the \`rationale\` field accepts text, and the renderer ignores it (humans review it).

HARD RULES:
1. The N concepts must look VISUALLY DIFFERENT — different layout_type AND different composition AND different primary_visual. Three identical-looking specs is a failure even if each spec is internally fine.
2. Match treatment to concept emotion:
   - "calm authority" / "trustworthy" / "premium" / "precise" → emphasis_level=quiet, palette_intensity in {calm, standard}, density in {minimal, balanced}
   - "alert focus" / "energetic" / "urgent" → emphasis_level=bold, palette_intensity=high_contrast, visual_weight in {balanced, dominant}
   - "measured optimism" / "balanced" → emphasis_level=balanced, palette_intensity=standard
3. Pick layout_type by concept SUBSTANCE (what the concept IS about), not aesthetic vibe:
   - Stat-led concept (a number + label is the hero) → editorial_type or data_focus
   - Platform / product visibility concept → mockup_hero
   - Texture / atmosphere / mood concept → pattern_immersive
   - Photographic subject concept → photo_immersive (rare; the brand mostly uses brand-locked gradients)
   - Comparison concept ("X vs Y", "before vs after") → split_panel
4. CTA emphasis tracks campaign goal:
   - awareness → cta.weight in {ghost, standard}
   - consideration → cta.weight=standard
   - conversion → cta.weight=loud
   - retention → cta.weight=standard
5. Brand discipline: at most ONE concept of N may use accent_usage=strong.
6. logo_prominence=prominent only when the concept is brand-led. Default standard.
7. format_adaptation: only override fields that genuinely differ per format. If the same plan reads cleanly across all 3 formats, leave format_adaptation as an empty object.

LAYOUT × COMPOSITION COMPATIBILITY (HARD CONSTRAINT — picks outside this table get auto-rewritten and warnings logged; pick correctly the first time):

  layout_type=mockup_hero       → composition MUST be text_leading OR visual_leading
                                  (mockup is a side panel; text on the other side)
  layout_type=pattern_immersive → composition MUST be hero_overlay
                                  (pattern fills canvas; text floats over it)
  layout_type=editorial_type    → composition MUST be hero_overlay
                                  (typography on a brand-color block)
  layout_type=photo_immersive   → composition MUST be hero_overlay  (rare — disabled in production)
  layout_type=split_panel       → composition: text_leading or visual_leading (collapses to mockup_hero)
  layout_type=data_focus        → composition=hero_overlay  (collapses to editorial_type)

  Picking the wrong composition for a layout doesn't make the design more interesting — it just gets rewritten. To make a design distinct, vary primary_visual / accent_usage / cta.weight / palette_intensity instead.

OTHER COMMON PITFALLS — these get auto-collapsed; pick the working alternative:

  text_strategy.headline_position = "top" or "bottom"
    → vertical anchor is composition's job (hero_overlay = bottom-anchored, top_down = top).
      Use "left" / "right" / "center" for HORIZONTAL anchoring of the text block.

  visual_strategy.visual_position = "foreground"
    → visual on top of text fails contrast. Always collapses to "auto".
      For "lead visual that dominates", use visual_position="background" + visual_weight="dominant".

  visual_strategy.visual_position = "center"
    → no centered-visual builder. Always collapses to "auto".

  cta_strategy.weight = "loud" + brand_strategy.accent_usage in {"none", "subtle"}
    → loud CTA needs accent_usage="cta_only" or "strong" to actually use the accent fill.
      Otherwise loud collapses to standard. Picking accent_usage="cta_only" is the typical match for a single loud CTA.

  primary_visual = "screenshot"
    → no chrome-free screenshot builder. Renders the same as "mockup". Pick "mockup" directly.

ENUMS — use exactly these values, never paraphrase:

layout_type: mockup_hero | editorial_type | pattern_immersive | photo_immersive | split_panel | data_focus
composition: text_leading | visual_leading | hero_overlay | centered | top_down | bottom_anchor
hierarchy.primary_focus / secondary_focus: headline | subheadline | mockup | stat | cta | visual
hierarchy.emphasis_level: quiet | balanced | bold
text_strategy.headline_position: left | right | center | top | bottom
text_strategy.headline_scale: compact | standard | large | hero
text_strategy.text_alignment: left | center | right
text_strategy.max_text_density: low | medium | high
visual_strategy.primary_visual: mockup | screenshot | motif | pattern | abstract_gradient | none
visual_strategy.visual_position: left | right | center | background | foreground
visual_strategy.visual_weight: subtle | balanced | dominant
visual_strategy.motif_hint (optional): chart_silhouette | abstract_bars | axis_grid | wave_curve | gradient_orb | node_network | arc_meter | ticker_strip | none
visual_strategy.pattern_hint (optional): diagonal_lines | diagonal_lines_reverse | vertical_bars | dot_grid | concentric_arcs | none
brand_strategy.background_style: solid | gradient | deep_gradient | split_color
brand_strategy.palette_intensity: calm | standard | high_contrast
brand_strategy.accent_usage: none | subtle | cta_only | strong
brand_strategy.logo_prominence: small | standard | prominent
cta_strategy.placement: below_headline | below_subheadline | bottom_left | bottom_center | bottom_right | top_right | inline_with_headline
cta_strategy.weight: ghost | standard | loud
cta_strategy.width: fit_text | fixed | full_text_block
spacing.density: minimal | balanced | rich
spacing.padding: tight | standard | airy
spacing.safe_area_priority: normal | high

The format_adaptation keys are: leaderboard (1200x628), square (1080x1080), portrait (1080x1920). Each value is a partial override of the top-level fields above (only composition, primary_visual, visual_position, visual_weight, headline_position, headline_scale, text_alignment, max_text_density, cta_placement, density, and a free-text "notes" field are overridable per-format).

Return JSON only — no prose, no markdown, no comments.`;

// Inline JSON template the model imitates. Mirrors VisualLayoutBatchSchema.
// Top-level key MUST be `specs` — do NOT wrap under "data", "output", etc.
const VISUAL_PLANNER_OUTPUT_TEMPLATE = `{
  "specs": [
    {
      "concept_id": "<exact concept_id from input>",
      "spec": {
        "spec_version": "1.0.0",
        "layout_type": "...",
        "composition": "...",
        "hierarchy": {
          "primary_focus": "...",
          "secondary_focus": "...",
          "emphasis_level": "..."
        },
        "text_strategy": {
          "headline_position": "...",
          "headline_scale": "...",
          "text_alignment": "...",
          "max_text_density": "..."
        },
        "visual_strategy": {
          "primary_visual": "...",
          "visual_position": "...",
          "visual_weight": "...",
          "use_mockup": true,
          "use_screenshot": true,
          "use_motif": true,
          "use_pattern": false,
          "motif_hint": "..."
        },
        "brand_strategy": {
          "background_style": "...",
          "palette_intensity": "...",
          "accent_usage": "...",
          "logo_prominence": "..."
        },
        "cta_strategy": {
          "placement": "...",
          "weight": "...",
          "width": "..."
        },
        "spacing": {
          "density": "...",
          "padding": "...",
          "safe_area_priority": "..."
        },
        "format_adaptation": {},
        "rationale": "1-3 sentences (≤600 chars) explaining why this design fits this concept"
      }
    }
    /* one entry per concept_id from the input plan, in the same order */
  ]
}`;

// Build the user prompt for the visual planner. Includes a compact view of
// each concept (id + name + tone + emotion + visual_direction + design_elements
// + copy_package excerpt) so the AI can ground its design picks in the actual
// concept rather than guessing.
function buildVisualPlannerUserPrompt(
  input: AIProviderInput,
  refined: AICampaignPlanRaw,
): string {
  const { brief, brandKit } = input;
  const palette = [
    ...brandKit.colors.primary,
    ...brandKit.colors.accent,
    ...brandKit.colors.background,
  ].join(", ");
  const conceptSummaries = refined.concepts.map((c) => {
    const lines = [
      `concept_id: ${c.concept_id}`,
      `name: ${c.name}`,
      `target_emotion: ${c.target_emotion}`,
      `tone: ${c.tone}`,
      `strategic_idea: ${c.strategic_idea}`,
      `desired_visual_context: ${c.desired_visual_context}`,
      `headline: ${c.copy_package.headline}`,
      `subheadline: ${c.copy_package.subheadline}`,
      `cta: ${c.copy_package.cta}`,
      `visual_direction: ${c.visual_direction.description}`,
    ];
    if (c.design_elements?.eyebrow) lines.push(`eyebrow: ${c.design_elements.eyebrow}`);
    if (c.design_elements?.stat) {
      lines.push(
        `stat: ${c.design_elements.stat.number} / ${c.design_elements.stat.label}`,
      );
    }
    return lines.join("\n");
  });
  return [
    `Brand: ${brandKit.brand_name} (${brandKit.brand_id})`,
    `Brand palette: ${palette}`,
    `Campaign goal: ${brief.campaign_goal}`,
    `Tone: ${brief.tone.join(", ")}`,
    `Required formats: ${brief.required_formats.join(", ")}`,
    `Output language: ${brief.language}`,
    "",
    `Plan: ${refined.campaign_name}`,
    `Summary: ${refined.campaign_summary}`,
    "",
    "Concepts (each needs one VisualLayoutSpec):",
    "",
    conceptSummaries.map((s, i) => `--- concept ${i + 1} ---\n${s}`).join("\n\n"),
    "",
    `Return one entry per concept_id, in the same order, in this exact JSON shape:`,
    "",
    VISUAL_PLANNER_OUTPUT_TEMPLATE,
  ].join("\n");
}

// Some models occasionally wrap the payload under a single envelope key
// ({ output: {...} } / { data: {...} }). Defensive unwrap mirroring the one
// used for the campaign plan.
function unwrapVisualBatchIfEnveloped(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const obj = raw as Record<string, unknown>;
  if ("specs" in obj) return obj;
  const keys = Object.keys(obj);
  if (keys.length !== 1) return obj;
  const inner = obj[keys[0]];
  if (
    inner &&
    typeof inner === "object" &&
    !Array.isArray(inner) &&
    "specs" in (inner as Record<string, unknown>)
  ) {
    return inner;
  }
  return obj;
}

// ── Mock provider (deterministic, dev-friendly, no network) ─────────────────
export class MockProvider implements AIProvider {
  readonly name = "mock" as const;
  async generateStructuredCampaignPlan(input: AIProviderInput): Promise<AICampaignPlanRaw> {
    const seed = stableSeed(input);
    return mockPlan(input, seed);
  }
  async planVisualLayoutsForCampaign(
    _input: AIProviderInput,
    refined: AICampaignPlanRaw,
  ): Promise<VisualLayoutBatch> {
    return mockVisualLayoutBatch(refined);
  }
}

function stableSeed(input: AIProviderInput): string {
  const json = JSON.stringify({
    brief: input.brief,
    brand_id: input.brandKit.brand_id,
  });
  return crypto.createHash("sha1").update(json).digest("hex").slice(0, 8);
}

interface MockConceptShape {
  name: string;
  strategic_idea: string;
  target_emotion: string;
  tone: string;
  context: MidjourneyContext;
  copy: {
    headline: string;
    headline_emphasis?: string;
    subheadline: string;
    body: string;
    cta: string;
    altHeads: string[];
    altCtas: string[];
  };
  composition: string;
  moodKeywords: string[];
}

function mockShapes(brief: CampaignBrief): MockConceptShape[] {
  const message = brief.marketing_message;
  return [
    {
      name: "Confidence at the close",
      strategic_idea: `Frame ${message.toLowerCase()} as quiet, earned authority — depth + restraint over flash.`,
      target_emotion: "calm authority",
      tone: brief.tone[0] ?? "confident",
      context:
        brief.preferred_contexts.find((c) => c === "charts") ?? "premium_fintech",
      copy: {
        headline: "ONE INVESTING ACCOUNT. ACCESS ACROSS EVERY DEVICE.",
        headline_emphasis: "ONE INVESTING ACCOUNT.",
        subheadline:
          "Real-time charts and order tools designed for clarity, not noise.",
        body: "Built for self-directed investors who want institutional-grade tooling without the institutional clutter.",
        cta: "Open an account",
        altHeads: [
          "Read the market clearly",
          "Charts that match your conviction",
          "Trade with the steady hand",
        ],
        altCtas: ["Start now", "Get started", "Explore platform"],
      },
      composition: "hero_left_mockup_right",
      moodKeywords: ["restrained", "luminous", "premium", "editorial"],
    },
    {
      name: "Diversify with discipline",
      strategic_idea: `Reposition ${message.toLowerCase()} around ETF-led diversification — disciplined, never reckless.`,
      target_emotion: "measured optimism",
      tone: brief.tone[1] ?? brief.tone[0] ?? "trustworthy",
      context: brief.preferred_contexts.find((c) => c === "etfs") ?? "etfs",
      copy: {
        headline: "GLOBAL INVESTING, LOCAL SUPPORT.",
        headline_emphasis: "GLOBAL INVESTING,",
        subheadline:
          "ETFs across global markets, with the platform tools to hold them through every cycle.",
        body: "From thematic to broad-index, ETFs you can compose and rebalance without leaving the dashboard.",
        cta: "Learn more",
        altHeads: [
          "Diversify with intent",
          "Composed portfolios, calmer markets",
          "Global ETFs, single dashboard",
        ],
        altCtas: ["Compare plans", "Open an account", "Start trading"],
      },
      composition: "centered_mockup_with_headline",
      moodKeywords: ["balanced", "geometric", "deep navy", "data-rich"],
    },
    {
      name: "Move with the market",
      strategic_idea: `Reframe ${message.toLowerCase()} around equity-focused trading — energy without recklessness.`,
      target_emotion: "alert focus",
      tone: brief.tone[2] ?? brief.tone[1] ?? brief.tone[0] ?? "energetic",
      context:
        brief.preferred_contexts.find((c) => c === "stocks") ?? "stocks",
      copy: {
        headline: "ACCESS FUTURES TRADING IN ONE PLATFORM",
        headline_emphasis: "ACCESS FUTURES TRADING",
        subheadline:
          "Watchlists, charts, and order flow tools tuned for traders who follow individual names.",
        body: "Real-time quotes, deep order book, and conditional orders — the trader's toolkit, polished.",
        cta: "Start trading",
        altHeads: [
          "From watchlist to order",
          "The trader's clean room",
          "Sharp tools, steady hand",
        ],
        altCtas: ["Explore platform", "Start now", "Open an account"],
      },
      composition: "split_text_visual",
      moodKeywords: ["alert", "vibrant restraint", "sharp", "premium"],
    },
  ];
}

function mockPlan(input: AIProviderInput, seed: string): AICampaignPlanRaw {
  const { brief, brandKit } = input;
  const palette = [
    ...brandKit.colors.primary,
    ...brandKit.colors.accent,
  ];
  const disclaimer = brief.risk_warning_required
    ? brandKit.legal.default_disclaimer || "Investing involves risk."
    : "";

  const shapes = mockShapes(brief);
  const concepts: AIConceptStub[] = shapes.map((s, i) => ({
    concept_id: `concept_${seed}_${i + 1}`,
    name: s.name,
    strategic_idea: s.strategic_idea,
    target_emotion: s.target_emotion,
    tone: s.tone,
    visual_direction: {
      description: `${s.composition.replaceAll("_", " ")} — ${s.moodKeywords.join(", ")}.`,
      primary_palette: palette,
      composition: s.composition,
      mood_keywords: s.moodKeywords,
    },
    copy_package: {
      headline: s.copy.headline,
      ...(s.copy.headline_emphasis ? { headline_emphasis: s.copy.headline_emphasis } : {}),
      subheadline: s.copy.subheadline,
      body: s.copy.body,
      cta: s.copy.cta,
      disclaimer,
      alternative_headlines: s.copy.altHeads,
      alternative_ctas: s.copy.altCtas,
      platform_copy_variations: (brief.platforms ?? []).map((p) => ({
        platform: p,
        headline: s.copy.headline,
        cta: s.copy.cta,
      })),
    },
    desired_visual_context: s.context,
    midjourney_prompt_pack: [
      {
        prompt_id: `${s.context}-bg-${i + 1}`,
        intended_use: "background",
        context: s.context,
        aspect_ratio: "1:1",
        prompt_text: `abstract premium fintech background, ${s.moodKeywords.join(", ")}, brand palette: ${palette.join(", ")}, leave clean negative space for marketing copy, no text, no logo, no watermark, no readable UI text, --ar 1:1 --style raw`,
        notes: "Concept-tuned background reference. Use as Midjourney style ref.",
      },
    ],
    // Step 10 — give concept 0 a kicker so high text density actually
    // has a layer to render. Concepts 1 and 2 stay kicker-free; their
    // specs use low/medium max_text_density and would skip it anyway.
    ...(i === 0
      ? {
          design_elements: {
            kicker: "Data you can act on. Tools that stay out of the way.",
          },
        }
      : {}),
  }));

  return AICampaignPlanRawSchema.parse({
    campaign_name: shapes[0].name + " (and 2 alternates)",
    campaign_summary:
      `Three angles on "${brief.marketing_message}"` +
      (brief.target_audience ? ` for ${brief.target_audience}` : "") +
      `, in ${brief.tone.join("/")} tone, optimized for ${brief.required_formats.join(", ")}.`,
    concepts,
  });
}

// ── Mock VisualLayoutSpec library ───────────────────────────────────────────
// Three deterministic specs covering the existing template families:
//   1. mockup_hero / text_leading / balanced — the "product visibility" look
//   2. pattern_immersive / hero_overlay / bold — the "texture-led" look
//   3. editorial_type / centered / quiet — the "stat-led" look
//
// Returned in order, one per concept. Cycles when N > 3. Does not depend on
// the brief language — RTL adaptation happens at render time, not in the spec.
const MOCK_VISUAL_SPECS: VisualLayoutBatch["specs"][number]["spec"][] = [
  {
    spec_version: "1.0.0",
    layout_type: "mockup_hero",
    composition: "text_leading",
    hierarchy: {
      primary_focus: "headline",
      secondary_focus: "mockup",
      emphasis_level: "balanced",
    },
    text_strategy: {
      headline_position: "left",
      headline_scale: "standard",
      text_alignment: "left",
      // Step 10 — high text density enables the kicker layer when the AI
      // emitted design_elements.kicker. Mock concept 1 carries one (see
      // mockPlan below) so the kicker line renders end-to-end.
      max_text_density: "high",
    },
    visual_strategy: {
      primary_visual: "mockup",
      visual_position: "right",
      visual_weight: "balanced",
      use_mockup: true,
      use_screenshot: true,
      use_motif: true,
      use_pattern: false,
    },
    brand_strategy: {
      background_style: "split_color",
      palette_intensity: "standard",
      accent_usage: "cta_only",
      logo_prominence: "standard",
    },
    cta_strategy: {
      placement: "below_subheadline",
      weight: "standard",
      width: "fit_text",
    },
    spacing: {
      density: "balanced",
      padding: "standard",
      safe_area_priority: "normal",
    },
    // Step 8 — portrait format flips to a centered presentation. The
    // narrow vertical canvas reads better with a centered headline +
    // bottom_center CTA than with the leaderboard's text-on-left layout.
    // Square and leaderboard inherit the top-level (text_leading, left).
    format_adaptation: {
      portrait: {
        headline_position: "center",
        text_alignment: "center",
        cta_placement: "bottom_center",
        notes: "Portrait reads better as a centered stack on phones.",
      },
    },
    rationale:
      "Mockup-led concept for a platform/product message. Balanced hierarchy keeps the headline primary and the device second. Standard CTA so the design reads as informational, not pressured.",
  },
  {
    spec_version: "1.0.0",
    layout_type: "pattern_immersive",
    composition: "hero_overlay",
    hierarchy: {
      primary_focus: "headline",
      secondary_focus: "cta",
      emphasis_level: "bold",
    },
    text_strategy: {
      headline_position: "bottom",
      headline_scale: "hero",
      text_alignment: "left",
      max_text_density: "low",
    },
    visual_strategy: {
      primary_visual: "pattern",
      visual_position: "background",
      visual_weight: "dominant",
      use_mockup: false,
      use_screenshot: false,
      use_motif: false,
      use_pattern: true,
      pattern_hint: "diagonal_lines",
    },
    brand_strategy: {
      background_style: "deep_gradient",
      palette_intensity: "high_contrast",
      accent_usage: "strong",
      logo_prominence: "standard",
    },
    cta_strategy: {
      placement: "bottom_band",
      weight: "loud",
      width: "fit_text",
    },
    spacing: {
      density: "minimal",
      padding: "airy",
      safe_area_priority: "normal",
    },
    format_adaptation: {
      portrait: {
        headline_scale: "large",
        composition: "bottom_anchor",
        notes: "Vertical canvas — anchor headline + CTA at bottom for thumb reach.",
      },
    },
    rationale:
      "Pattern-immersive treatment carries a texture-led concept. Bold emphasis with a loud CTA matches conversion-leaning energy. Portrait flips to bottom_anchor so vertical scroll reads cleanly.",
  },
  {
    spec_version: "1.0.0",
    layout_type: "editorial_type",
    composition: "centered",
    hierarchy: {
      primary_focus: "stat",
      secondary_focus: "headline",
      emphasis_level: "quiet",
    },
    text_strategy: {
      headline_position: "center",
      headline_scale: "standard",
      text_alignment: "center",
      max_text_density: "low",
    },
    visual_strategy: {
      primary_visual: "motif",
      visual_position: "background",
      visual_weight: "subtle",
      use_mockup: false,
      use_screenshot: false,
      use_motif: true,
      use_pattern: false,
      motif_hint: "axis_grid",
    },
    brand_strategy: {
      background_style: "solid",
      palette_intensity: "calm",
      accent_usage: "none",
      logo_prominence: "small",
    },
    cta_strategy: {
      placement: "bottom_center",
      weight: "ghost",
      width: "fit_text",
    },
    spacing: {
      density: "minimal",
      padding: "airy",
      safe_area_priority: "high",
    },
    // Step 8 — top-level says max_text_density="low" (subheadline
    // suppressed). Leaderboard's wide canvas can absorb the subheadline,
    // so the per-format override bumps it back to "medium". Square and
    // portrait inherit the top-level "low" (no subheadline), making the
    // editorial / stat-led intent dominate on those crops.
    format_adaptation: {
      leaderboard: {
        max_text_density: "medium",
        notes: "Leaderboard has the horizontal room to show the subheadline.",
      },
    },
    rationale:
      "Editorial typography for the data-led concept. Stat is the hero; everything else recedes. Calm palette and ghost CTA reinforce the trustworthy/precise tone.",
  },
];

function mockVisualLayoutBatch(refined: AICampaignPlanRaw): VisualLayoutBatch {
  return VisualLayoutBatchSchema.parse({
    specs: refined.concepts.map((c, i) => ({
      concept_id: c.concept_id,
      spec: MOCK_VISUAL_SPECS[i % MOCK_VISUAL_SPECS.length],
    })),
  });
}

// ── OpenAI provider ─────────────────────────────────────────────────────────
export class OpenAIProvider implements AIProvider {
  readonly name = "openai" as const;

  async generateStructuredCampaignPlan(
    input: AIProviderInput,
    opts?: AIProviderCallOpts,
  ): Promise<AICampaignPlanRaw> {
    requireEnv("OPENAI_API_KEY");
    // Default to gpt-4o for noticeably stronger copywriting / concept variety
    // than gpt-4o-mini. Override with OPENAI_MODEL in .env.local.
    const model = process.env.OPENAI_MODEL ?? "gpt-4o";
    let OpenAI: typeof import("openai").default;
    try {
      OpenAI = (await import("openai")).default;
    } catch (err) {
      throw new Error(
        `OpenAI SDK not installed. ${redact((err as Error).message)}`,
      );
    }
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    // creative_mode="exploratory" bumps the divergence knob AND appends
    // the creative-licence addendum to the system prompt. Schema validation
    // still rejects off-shape responses; the renderer's clamps still
    // protect the layout. 1.15 is at the upper end of where gpt-4o still
    // produces valid JSON reliably.
    const isExploratory = opts?.creativeMode === "exploratory";
    const temperature = isExploratory ? 1.15 : 0.85;
    const systemPrompt = isExploratory
      ? SYSTEM_PROMPT + EXPLORATORY_CONCEPT_SUFFIX
      : SYSTEM_PROMPT;
    let raw: unknown;
    try {
      const completion = await client.chat.completions.create({
        model,
        response_format: { type: "json_object" },
        max_tokens: 4096,
        // Higher temperature encourages the 3 concepts to diverge instead of
        // collapsing into variants of the same idea.
        temperature,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: buildUserPrompt(input) },
        ],
      });
      const text = completion.choices[0]?.message?.content ?? "{}";
      raw = unwrapIfEnveloped(JSON.parse(text));
    } catch (err) {
      throw new Error(`OpenAI call failed: ${redact((err as Error).message)}`);
    }
    return AICampaignPlanRawSchema.parse(raw);
  }

  // Critique pass — same model, dedicated system prompt. In standard mode
  // it's a discipline pass at temperature 0.4 (kills consultant-ese). In
  // exploratory mode it becomes a CREATIVE-STRETCH pass at temperature 0.8
  // — same JSON shape, but pushes for divergence and braver framing
  // instead of polish. campaignPlanner only invokes this method when the
  // appropriate mode wants a second pass.
  async refineCampaignPlan(
    input: AIProviderInput,
    initial: AICampaignPlanRaw,
    opts?: AIProviderCallOpts,
  ): Promise<AICampaignPlanRaw> {
    requireEnv("OPENAI_API_KEY");
    const model = process.env.OPENAI_MODEL ?? "gpt-4o";
    const OpenAI = (await import("openai")).default;
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const isExploratory = opts?.creativeMode === "exploratory";
    const refinementPrompt = isExploratory
      ? CREATIVE_STRETCH_SYSTEM_PROMPT
      : CRITIQUE_SYSTEM_PROMPT;
    const baseSystem = isExploratory
      ? SYSTEM_PROMPT + EXPLORATORY_CONCEPT_SUFFIX
      : SYSTEM_PROMPT;
    const temperature = isExploratory ? 0.8 : 0.4;
    const userPromptHeader = isExploratory
      ? "\n\nINITIAL PLAN TO STRETCH (apply the creative-stretch standards above):\n"
      : "\n\nINITIAL PLAN TO REFINE (apply the critique standards above):\n";
    const userPrompt = buildUserPrompt(input) + userPromptHeader + JSON.stringify(initial, null, 2);
    const completion = await client.chat.completions.create({
      model,
      response_format: { type: "json_object" },
      max_tokens: 4096,
      temperature,
      messages: [
        { role: "system", content: baseSystem },
        { role: "system", content: refinementPrompt },
        { role: "user", content: userPrompt },
      ],
    });
    const text = completion.choices[0]?.message?.content ?? "{}";
    return AICampaignPlanRawSchema.parse(unwrapIfEnveloped(JSON.parse(text)));
  }

  // Visual planner pass — temperature 0.5 (lower than the concept-gen 0.85
  // because we want disciplined enum picks, but higher than the critique 0.4
  // because we still want concept-to-concept differentiation). In
  // exploratory mode this jumps to 0.75 so the AI takes more design risks
  // (more unusual layout/composition combos, looser brand-discipline
  // self-policing).
  async planVisualLayoutsForCampaign(
    input: AIProviderInput,
    refined: AICampaignPlanRaw,
    opts?: AIProviderCallOpts,
  ): Promise<VisualLayoutBatch> {
    requireEnv("OPENAI_API_KEY");
    const model = process.env.OPENAI_MODEL ?? "gpt-4o";
    const OpenAI = (await import("openai")).default;
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const isExploratory = opts?.creativeMode === "exploratory";
    const temperature = isExploratory ? 0.95 : 0.5;
    const systemPrompt = isExploratory
      ? VISUAL_PLANNER_SYSTEM_PROMPT + EXPLORATORY_VISUAL_PLANNER_SUFFIX
      : VISUAL_PLANNER_SYSTEM_PROMPT;
    const completion = await client.chat.completions.create({
      model,
      response_format: { type: "json_object" },
      max_tokens: 4096,
      temperature,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: buildVisualPlannerUserPrompt(input, refined),
        },
      ],
    });
    const text = completion.choices[0]?.message?.content ?? "{}";
    return VisualLayoutBatchSchema.parse(
      unwrapVisualBatchIfEnveloped(JSON.parse(text)),
    );
  }
}

// ── Anthropic provider ──────────────────────────────────────────────────────
export class AnthropicProvider implements AIProvider {
  readonly name = "anthropic" as const;

  async generateStructuredCampaignPlan(
    input: AIProviderInput,
    opts?: AIProviderCallOpts,
  ): Promise<AICampaignPlanRaw> {
    requireEnv("ANTHROPIC_API_KEY");
    const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";
    let Anthropic: typeof import("@anthropic-ai/sdk").default;
    try {
      Anthropic = (await import("@anthropic-ai/sdk")).default;
    } catch (err) {
      throw new Error(
        `Anthropic SDK not installed. ${redact((err as Error).message)}`,
      );
    }
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    // Anthropic's max temperature is 1.0; exploratory pushes to that ceiling
    // and appends the creative-licence addendum to compensate for the
    // lower headroom (vs OpenAI's 1.15).
    const isExploratory = opts?.creativeMode === "exploratory";
    const temperature = isExploratory ? 1.0 : 0.85;
    const systemPrompt = isExploratory
      ? SYSTEM_PROMPT + EXPLORATORY_CONCEPT_SUFFIX
      : SYSTEM_PROMPT;
    let raw: unknown;
    try {
      const response = await client.messages.create({
        model,
        max_tokens: 4096,
        temperature,
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content:
              buildUserPrompt(input) +
              "\n\nRespond with a single JSON object. No prose.",
          },
        ],
      });
      const block = response.content.find((b) => b.type === "text");
      const text = block && "text" in block ? block.text : "{}";
      // Strip optional code-fence wrapping.
      const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
      raw = unwrapIfEnveloped(JSON.parse(cleaned));
    } catch (err) {
      throw new Error(`Anthropic call failed: ${redact((err as Error).message)}`);
    }
    return AICampaignPlanRawSchema.parse(raw);
  }

  async refineCampaignPlan(
    input: AIProviderInput,
    initial: AICampaignPlanRaw,
    opts?: AIProviderCallOpts,
  ): Promise<AICampaignPlanRaw> {
    requireEnv("ANTHROPIC_API_KEY");
    const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const isExploratory = opts?.creativeMode === "exploratory";
    const refinementPrompt = isExploratory
      ? CREATIVE_STRETCH_SYSTEM_PROMPT
      : CRITIQUE_SYSTEM_PROMPT;
    const baseSystem = isExploratory
      ? SYSTEM_PROMPT + EXPLORATORY_CONCEPT_SUFFIX
      : SYSTEM_PROMPT;
    const temperature = isExploratory ? 0.8 : 0.4;
    const userPromptHeader = isExploratory
      ? "\n\nINITIAL PLAN TO STRETCH (apply the creative-stretch standards):\n"
      : "\n\nINITIAL PLAN TO REFINE (apply the critique standards):\n";
    const userPrompt =
      buildUserPrompt(input) +
      userPromptHeader +
      JSON.stringify(initial, null, 2) +
      "\n\nReturn the refined JSON object only.";
    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      temperature,
      system: `${baseSystem}\n\n${refinementPrompt}`,
      messages: [{ role: "user", content: userPrompt }],
    });
    const block = response.content.find((b) => b.type === "text");
    const text = block && "text" in block ? block.text : "{}";
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
    return AICampaignPlanRawSchema.parse(unwrapIfEnveloped(JSON.parse(cleaned)));
  }

  async planVisualLayoutsForCampaign(
    input: AIProviderInput,
    refined: AICampaignPlanRaw,
    opts?: AIProviderCallOpts,
  ): Promise<VisualLayoutBatch> {
    requireEnv("ANTHROPIC_API_KEY");
    const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const isExploratory = opts?.creativeMode === "exploratory";
    const temperature = isExploratory ? 0.95 : 0.5;
    const systemPrompt = isExploratory
      ? VISUAL_PLANNER_SYSTEM_PROMPT + EXPLORATORY_VISUAL_PLANNER_SUFFIX
      : VISUAL_PLANNER_SYSTEM_PROMPT;
    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      temperature,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content:
            buildVisualPlannerUserPrompt(input, refined) +
            "\n\nReturn the JSON object only.",
        },
      ],
    });
    const block = response.content.find((b) => b.type === "text");
    const text = block && "text" in block ? block.text : "{}";
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
    return VisualLayoutBatchSchema.parse(
      unwrapVisualBatchIfEnveloped(JSON.parse(cleaned)),
    );
  }
}

// ── Gemini provider ─────────────────────────────────────────────────────────
// Same AIProvider contract as OpenAI/Anthropic, against Google's Gen AI SDK
// (`@google/genai`, already used by the visionQa module). Gemini brings a
// distinctly different creative voice — adding it as a third strategy
// provider widens the variety of concepts the planner can produce.
//
// Implements the required `generateStructuredCampaignPlan`. The optional
// `refineCampaignPlan` / `planVisualLayoutsForCampaign` are deliberately
// skipped for the MVP: the planner falls back to the original plan + PRNG
// visual choices when those are absent, which is fine and keeps the
// rollout small. Both can be added later for parity with OpenAI.
export class GeminiProvider implements AIProvider {
  readonly name = "gemini" as const;

  async generateStructuredCampaignPlan(
    input: AIProviderInput,
    opts?: AIProviderCallOpts,
  ): Promise<AICampaignPlanRaw> {
    requireEnv("GEMINI_API_KEY");
    const model = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
    let GoogleGenAI: typeof import("@google/genai").GoogleGenAI;
    try {
      ({ GoogleGenAI } = await import("@google/genai"));
    } catch (err) {
      throw new Error(
        `Gemini SDK not installed. ${redact((err as Error).message)}`,
      );
    }
    const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const isExploratory = opts?.creativeMode === "exploratory";
    // Gemini's temperature range is 0..2. 0.85 standard / 1.2 exploratory
    // mirrors OpenAI's calibration; higher than ~1.3 starts producing
    // malformed JSON on Gemini-Flash.
    const temperature = isExploratory ? 1.2 : 0.85;
    const systemPrompt = isExploratory
      ? SYSTEM_PROMPT + EXPLORATORY_CONCEPT_SUFFIX
      : SYSTEM_PROMPT;
    // Retry on 503 UNAVAILABLE — gemini-2.5-flash is throttled and
    // returns "high demand" responses regularly. Exponential backoff,
    // max 4 attempts (matches the visionQa module's retry policy).
    const callOnce = async () =>
      client.models.generateContent({
        model,
        contents: [
          { role: "user", parts: [{ text: buildUserPrompt(input) }] },
        ],
        config: {
          systemInstruction: { parts: [{ text: systemPrompt }] },
          temperature,
          responseMimeType: "application/json",
          // Bumped from 4096 because Gemini-Flash's JSON for a 3-concept
          // plan with midjourney_prompt_pack regularly lands at 5-6k tokens.
          maxOutputTokens: 8192,
        },
      });
    let raw: unknown;
    try {
      let resp: Awaited<ReturnType<typeof callOnce>> | null = null;
      let lastErr: unknown = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          resp = await callOnce();
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          const msg = (err as Error)?.message ?? "";
          const isRetryable =
            msg.includes("503") || msg.includes("UNAVAILABLE") || msg.includes("429");
          if (!isRetryable || attempt === 3) throw err;
          // Exponential backoff: 1s, 3s, 7s
          const delayMs = 1000 * Math.pow(2, attempt + 1) - 1000;
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }
      if (!resp) throw lastErr ?? new Error("Gemini call failed without a response");
      const text = (resp.text ?? "").trim();
      if (!text) {
        throw new Error("Gemini returned an empty response");
      }
      raw = unwrapIfEnveloped(JSON.parse(text));
    } catch (err) {
      throw new Error(`Gemini call failed: ${redact((err as Error).message)}`);
    }
    return AICampaignPlanRawSchema.parse(raw);
  }
}

export function getAIProvider(name: AIProviderName = readProviderName()): AIProvider {
  switch (name) {
    case "openai":
      return new OpenAIProvider();
    case "anthropic":
      return new AnthropicProvider();
    case "gemini":
      return new GeminiProvider();
    case "mock":
    default:
      return new MockProvider();
  }
}

export async function generateStructuredCampaignPlan(
  input: AIProviderInput,
  providerName?: AIProviderName,
): Promise<AICampaignPlanRaw> {
  const provider = getAIProvider(providerName ?? readProviderName());
  return provider.generateStructuredCampaignPlan(input);
}

// Strip Authorization headers / api_key= / Bearer tokens from any error
// surface before they get logged.
function redact(s: string): string {
  return s
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/api_key=[^&\s)]*/gi, "api_key=[redacted]")
    .replace(/sk-[A-Za-z0-9._-]{8,}/g, "sk-[redacted]");
}
