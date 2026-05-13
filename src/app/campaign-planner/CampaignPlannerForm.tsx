"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  CampaignBriefInputSchema,
  type CampaignBriefInput,
  type CampaignFormat,
} from "@/lib/schemas/campaignBrief.schema";
import { SCREENSHOT_CONTEXTS } from "@/lib/schemas/screenshotContext.schema";
import { LANGUAGES, LANG_META, type Language } from "@/lib/i18n/language";

const ALL_CONTEXTS = SCREENSHOT_CONTEXTS;

// Form for /campaign-planner.
//
// State is managed locally; on submit we Zod-validate against
// CampaignBriefInputSchema (the same schema the API route validates) so the
// user sees field-level errors before we even hit the network. The API route
// re-validates as a defensive line.

type Provider = "mock" | "openai" | "anthropic" | "gemini";

const ALL_FORMATS: CampaignFormat[] = [
  "1200x628",
  "1080x1080",
  "1080x1920",
  "1080x1350",
  "1200x675",
  "1200x1200",
  "1500x500",
  "1920x1080",
];
const DEFAULT_FORMATS: CampaignFormat[] = [
  "1200x628",
  "1080x1080",
  "1080x1920",
];
const ALL_GOALS = ["awareness", "consideration", "conversion", "retention"] as const;
const TONE_SUGGESTIONS = [
  "confident",
  "trustworthy",
  "premium",
  "energetic",
  "analytical",
  "approachable",
];

interface Props {
  brandId: string;
  defaultProvider: Provider;
}

export function CampaignPlannerForm({ brandId, defaultProvider }: Props) {
  const router = useRouter();
  const [marketing_message, setMarketingMessage] = useState(
    "Trade global markets with confidence",
  );
  const [campaign_goal, setCampaignGoal] = useState<typeof ALL_GOALS[number]>("consideration");
  const [tone, setTone] = useState<string[]>(["confident", "trustworthy", "premium"]);
  const [toneInput, setToneInput] = useState("");
  const [required_formats, setRequiredFormats] = useState<CampaignFormat[]>([
    ...DEFAULT_FORMATS,
  ]);
  const [preferred_contexts, setPreferredContexts] = useState<string[]>([
    "general_platform",
  ]);
  const [risk_warning_required, setRiskWarning] = useState(true);
  const [language, setLanguage] = useState<Language>("en");
  const [notes, setNotes] = useState("");
  const [provider, setProvider] = useState<Provider>(defaultProvider);
  const [setActive, setSetActive] = useState(true);
  const [autoGenerateImages, setAutoGenerateImages] = useState(false);
  const [autoRender, setAutoRender] = useState(true);
  // Step 12 — creative-mode hatch. "exploratory" gives the AI more freedom
  // (higher temperature, skips the critique pass that kills consultant-ese,
  // softer brand-discipline rules in the visual planner). The renderer's
  // safety clamps still apply, so layouts stay readable. Default off.
  const [creativeMode, setCreativeMode] = useState<"standard" | "exploratory">(
    "standard",
  );
  // Phase 3 — generated-asset injection. Operator pastes asset ids from
  // /asset-generator (or /api/generators/registry); the planner resolves them
  // against data/generated-assets.generated.json. Empty/blank → no-op.
  const [generatedAssetIdsRaw, setGeneratedAssetIdsRaw] = useState("");
  // Diversity controls — see CampaignBriefSchema. Empty seed = today's
  // behaviour (PRNG keyed off campaign_id only). Different seed = fresh
  // visual picks for the same brief. max_diversity forces 3 distinct
  // templates/motifs/palettes across the 3 concepts.
  const [diversitySeedRaw, setDiversitySeedRaw] = useState<string>("");
  const [maxDiversity, setMaxDiversity] = useState<boolean>(false);
  // SVG upload (new flow). When set, the campaign is generated via
  // /api/generate-campaign-from-svg — the existing AI/translator pipeline
  // runs as usual but the SVG is injected into every ad spec's manifest
  // as a decorative full-bleed layer (does not replace existing elements).
  const [svgContent, setSvgContent] = useState<string | null>(null);
  const [svgFileName, setSvgFileName] = useState<string | null>(null);
  // textType-driven copy. When ON, copy comes from translator's /by-message
  // endpoint (per-field generation with platform-conventional textType +
  // length); when OFF, the existing /batch path is used. Default ON.
  const [useTextTypeCopy, setUseTextTypeCopy] = useState<boolean>(true);

  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<{ path: string; message: string }[] | null>(null);
  const [isPending, startTransition] = useTransition();

  function toggle<T extends string>(arr: T[], v: T): T[] {
    return arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setIssues(null);

    const generated_asset_ids = generatedAssetIdsRaw
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const seedTrim = diversitySeedRaw.trim();
    const seedNum = seedTrim ? Number(seedTrim) : NaN;
    const brief: CampaignBriefInput = {
      brand_id: brandId,
      marketing_message: marketing_message.trim(),
      campaign_goal,
      tone,
      required_formats,
      preferred_contexts: preferred_contexts as CampaignBriefInput["preferred_contexts"],
      risk_warning_required,
      language,
      notes: notes.trim() || undefined,
      creative_mode: creativeMode,
      generated_asset_ids:
        generated_asset_ids.length > 0 ? generated_asset_ids : undefined,
      diversity_seed:
        Number.isFinite(seedNum) && seedNum >= 0 ? Math.floor(seedNum) : undefined,
      max_diversity: maxDiversity ? true : undefined,
      use_text_type_copy: useTextTypeCopy ? true : undefined,
    };

    const parsed = CampaignBriefInputSchema.safeParse(brief);
    if (!parsed.success) {
      setIssues(
        parsed.error.issues.map((i) => ({
          path: i.path.map(String).join("."),
          message: i.message,
        })),
      );
      return;
    }

    startTransition(async () => {
      try {
        // When the operator uploaded an SVG, route to the SVG-aware endpoint
        // — same brief, but the SVG is injected as a decorative layer on
        // every ad spec. Otherwise use the standard endpoint.
        const endpoint = svgContent
          ? "/api/generate-campaign-from-svg"
          : "/api/generate-campaign";
        const body = svgContent
          ? {
              brief: parsed.data,
              ai_provider: provider,
              set_as_active: setActive,
              svg: svgContent,
            }
          : {
              brief: parsed.data,
              ai_provider: provider,
              set_as_active: setActive,
              auto_generate_images: autoGenerateImages,
            };
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const json = (await res.json()) as
          | { ok: true; campaign_id: string }
          | { ok: false; error: string; message?: string; issues?: unknown };
        if (!res.ok || !json.ok) {
          const j = json as { error: string; message?: string };
          setError(j.message ?? j.error ?? `HTTP ${res.status}`);
          return;
        }
        // Optionally render PNGs before redirecting so the campaign page
        // shows the rendered banners on first load. Synchronous (~30s) but
        // it's the difference between "I got nothing" and "here are 9 PNGs."
        if (autoRender) {
          try {
            await fetch("/api/render-campaign", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ campaign_id: json.campaign_id }),
            });
          } catch {
            // Non-fatal — the campaign detail page has a "Render now" button.
          }
        }
        router.push(`/campaigns/${json.campaign_id}`);
      } catch (err) {
        setError((err as Error).message);
      }
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <Field
        label="Marketing message"
        hint="The single sentence the campaign is built around."
      >
        <textarea
          className={textareaCls}
          value={marketing_message}
          onChange={(e) => setMarketingMessage(e.target.value)}
          rows={2}
          required
        />
      </Field>

      <Field label="Campaign goal">
        <div className="flex flex-wrap gap-2">
          {ALL_GOALS.map((g) => (
            <label
              key={g}
              className={pillCls(campaign_goal === g)}
            >
              <input
                type="radio"
                name="goal"
                className="sr-only"
                checked={campaign_goal === g}
                onChange={() => setCampaignGoal(g)}
              />
              {g}
            </label>
          ))}
        </div>
      </Field>

      <Field label="Tone" hint="One or more — drives copy voice and visual mood.">
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            {Array.from(new Set([...TONE_SUGGESTIONS, ...tone])).map((t) => (
              <label key={t} className={pillCls(tone.includes(t))}>
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={tone.includes(t)}
                  onChange={() => setTone(toggle(tone, t))}
                />
                {t}
              </label>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              className={inputCls}
              placeholder="Add custom tone…"
              value={toneInput}
              onChange={(e) => setToneInput(e.target.value)}
            />
            <button
              type="button"
              className={smallBtnCls}
              onClick={() => {
                const v = toneInput.trim();
                if (v && !tone.includes(v)) setTone([...tone, v]);
                setToneInput("");
              }}
            >
              Add
            </button>
          </div>
        </div>
      </Field>

      <Field label="Required formats" hint="One ad spec is built per format, per concept.">
        <div className="flex flex-wrap gap-2">
          {ALL_FORMATS.map((f) => (
            <label key={f} className={pillCls(required_formats.includes(f))}>
              <input
                type="checkbox"
                className="sr-only"
                checked={required_formats.includes(f)}
                onChange={() => setRequiredFormats(toggle(required_formats, f))}
              />
              {f}
            </label>
          ))}
        </div>
      </Field>

      <Field
        label="Preferred screenshot contexts"
        hint="Drives which platform screenshots can be selected. Pick at least one."
      >
        <div className="flex flex-wrap gap-2">
          {ALL_CONTEXTS.map((c) => (
            <label key={c} className={pillCls(preferred_contexts.includes(c))}>
              <input
                type="checkbox"
                className="sr-only"
                checked={preferred_contexts.includes(c)}
                onChange={() => setPreferredContexts(toggle(preferred_contexts, c))}
              />
              {c}
            </label>
          ))}
        </div>
      </Field>

      <Field
        label="Output language"
        hint="The AI writes every text field — headlines, subheadlines, CTAs, disclaimers, eyebrows, stats — in the chosen language. Hebrew and Arabic flip text alignment to right and the CTA arrow to ←. The render route loads matching script fonts (Heebo / Cairo / Noto Sans Hebrew / Noto Sans Arabic) so glyphs render cleanly."
      >
        <div className="flex flex-wrap gap-2">
          {LANGUAGES.map((code) => (
            <label key={code} className={pillCls(language === code)}>
              <input
                type="radio"
                name="language"
                className="sr-only"
                checked={language === code}
                onChange={() => setLanguage(code)}
              />
              {LANG_META[code].nativeName}
            </label>
          ))}
        </div>
      </Field>

      <Field label="Risk warning">
        <label className="inline-flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={risk_warning_required}
            onChange={(e) => setRiskWarning(e.target.checked)}
          />
          Require regulatory disclaimer on every ad
        </label>
      </Field>

      <Field label="Notes" hint="Optional. Free-form context for the AI.">
        <textarea
          className={textareaCls}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
        />
      </Field>

      <Field
        label="Generated asset IDs"
        hint="Optional. Asset Generator outputs to inject — one per line, or comma-separated. The pipeline resolves each id against data/generated-assets.generated.json and uses it by role (background / cta / mockup / fx_overlay / trading_ui). Missing ids warn and are skipped. You can also drop `use_generated_asset:<id>` lines into the Notes field above and they'll be picked up too."
      >
        <textarea
          className={textareaCls}
          value={generatedAssetIdsRaw}
          onChange={(e) => setGeneratedAssetIdsRaw(e.target.value)}
          rows={3}
          placeholder="asset_cta_4f1c8e&#10;asset_background_…&#10;asset_mockup_…"
        />
      </Field>

      {/* Diversity controls — operator can shuffle visuals without changing copy. */}
      <Field
        label="Visual diversity"
        hint="Same brief can produce different visuals across runs. Set a seed to shuffle the per-concept template / motif / palette picks. Toggle 'Max diversity' to force the 3 concepts to use 3 distinct templates and motifs."
      >
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex flex-col text-xs">
            <span className="text-zinc-700 dark:text-zinc-300">Diversity seed (optional)</span>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                value={diversitySeedRaw}
                onChange={(e) => setDiversitySeedRaw(e.target.value)}
                placeholder="e.g. 42"
                className="w-32 rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              />
              <button
                type="button"
                onClick={() => setDiversitySeedRaw(String(Math.floor(Math.random() * 1_000_000)))}
                className={smallBtnCls}
                title="Pick a random seed (1-1,000,000)"
              >
                ↻ Shuffle
              </button>
            </div>
          </label>
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={maxDiversity}
              onChange={(e) => setMaxDiversity(e.target.checked)}
              className="h-4 w-4"
            />
            <span>Max diversity (3 distinct templates + motifs)</span>
          </label>
        </div>
      </Field>

      {/* Step 12 — Creative mode (creative direction, not layout). */}
      <Field
        label="Creative direction"
        hint="Standard = today's polished, on-brand result (recommended for production). Exploratory = high temperature, replaces the critique pass with a 'creative-stretch' pass that pushes for braver / more divergent concepts, softens brand-discipline soft rules, and tells the AI explicitly that brand colors / disclaimer / layout safety are renderer-locked so it can't break brand by being creative. The renderer's hard safety still applies (no overlapping text, brand colors, disclaimer band) — only the AI's creative latitude changes."
      >
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            <label className={pillCls(creativeMode === "standard")}>
              <input
                type="radio"
                name="creative_mode"
                className="sr-only"
                checked={creativeMode === "standard"}
                onChange={() => setCreativeMode("standard")}
              />
              Standard — disciplined, on-brand
            </label>
            <label className={pillCls(creativeMode === "exploratory")}>
              <input
                type="radio"
                name="creative_mode"
                className="sr-only"
                checked={creativeMode === "exploratory"}
                onChange={() => setCreativeMode("exploratory")}
              />
              Exploratory — looser AI, more variety
            </label>
          </div>
          {creativeMode === "exploratory" && (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
              <strong>Heads up:</strong> exploratory mode produces more diverse
              copy and bolder design choices. Some campaigns may be off-tone
              and need a re-roll — try generating 2–3 times and pick the best.
              Layout safety, brand colors, and the disclaimer band stay locked.
            </div>
          )}
        </div>
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="AI provider">
          <select
            className={inputCls}
            value={provider}
            onChange={(e) => setProvider(e.target.value as Provider)}
          >
            <option value="mock">mock (deterministic, no network)</option>
            <option value="openai">openai (requires OPENAI_API_KEY)</option>
            <option value="anthropic">anthropic (requires ANTHROPIC_API_KEY)</option>
            <option value="gemini">gemini (requires GEMINI_API_KEY)</option>
          </select>
        </Field>

        <Field label="Set as active campaign">
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={setActive}
              onChange={(e) => setSetActive(e.target.checked)}
            />
            Visual Preview / Code Render will load this campaign
          </label>
        </Field>
      </div>

      <Field
        label="Copy generation mode"
        hint="textType-driven: each banner field (headline, sub, cta, disclaimer, eyebrow, kicker) is generated in its own focused OpenAI call with platform-conventional length / convention (landing_headline 60, cta_button 24, email_body 600, etc.). More effective per-field, ~5x the LLM cost compared to the batched mode."
      >
        <label className="inline-flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={useTextTypeCopy}
            onChange={(e) => setUseTextTypeCopy(e.target.checked)}
          />
          Use textType-driven copy (recommended)
        </label>
      </Field>

      <Field
        label="Upload SVG (optional)"
        hint="When provided, the SVG is saved and injected into every ad spec as a full-bleed decorative layer above the background and below the mockup / text. The AI strategy + translator copy pipeline is unchanged — only the visual atmosphere is overridden. Routes the request to /api/generate-campaign-from-svg."
      >
        <div className="flex items-center gap-3">
          <input
            type="file"
            accept=".svg,image/svg+xml"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) {
                setSvgContent(null);
                setSvgFileName(null);
                return;
              }
              const text = await file.text();
              setSvgContent(text);
              setSvgFileName(file.name);
            }}
            className="text-sm"
          />
          {svgFileName ? (
            <span className="text-xs text-zinc-600 dark:text-zinc-400">
              ✓ {svgFileName} ({(svgContent?.length ?? 0).toLocaleString()} chars)
              <button
                type="button"
                onClick={() => { setSvgContent(null); setSvgFileName(null); }}
                className="ml-2 underline"
              >
                clear
              </button>
            </span>
          ) : (
            <span className="text-xs text-zinc-500">no SVG selected</span>
          )}
        </div>
      </Field>

      <Field
        label="Auto-generate AI imagery (OpenAI Images, optional)"
        hint="Runs each concept's prompt pack through gpt-image-1 and saves the results as approved uploads. AUTO-GENERATED IMAGES ARE NOT ROUTED ONTO ADS — the renderer uses brand-locked gradients + a clean geometric pattern instead, because AI photography consistently leaked text glyphs and fought the brand palette. The generated images stay visible at /midjourney for hand-curation; an operator can manually upload + assign the good ones to override the gradient. Roughly $0.40 per campaign."
      >
        <label className="inline-flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={autoGenerateImages}
            onChange={(e) => setAutoGenerateImages(e.target.checked)}
          />
          Generate AI imagery for the prompt pack (saved to /midjourney for review)
        </label>
      </Field>

      <Field
        label="Auto-render PNGs"
        hint="After the plan is saved, also produce flat PNG banners for every (concept × format) ad via headless Chromium. Adds ~30s to generation time but means the campaign page shows the rendered ads on first load. Off → only the JSON plan is saved; you click 'Render PNGs now' on the detail page when ready."
      >
        <label className="inline-flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={autoRender}
            onChange={(e) => setAutoRender(e.target.checked)}
          />
          Render PNGs immediately after generating the plan
        </label>
      </Field>

      {issues && (
        <div className="rounded-md border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900 dark:border-rose-700 dark:bg-rose-950/40 dark:text-rose-200">
          <p className="font-medium">Brief is invalid:</p>
          <ul className="ml-4 list-disc">
            {issues.map((i, idx) => (
              <li key={idx}>
                <code className="font-mono">{i.path}</code>: {i.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      {error && (
        <div className="rounded-md border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900 dark:border-rose-700 dark:bg-rose-950/40 dark:text-rose-200">
          {error}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={isPending}
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          {isPending ? "Generating…" : "Generate campaign"}
        </button>
        <button
          type="button"
          disabled={isPending}
          onClick={() => onGenerateVariants(3)}
          className="rounded-md border border-zinc-900 bg-white px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-100 dark:bg-zinc-950 dark:text-zinc-100 dark:hover:bg-zinc-900"
          title="Run the same brief 3 times with 3 different diversity seeds. Costs ~3× tokens."
        >
          {isPending ? "Generating…" : "Generate 3 variants"}
        </button>
        <span className="text-xs text-zinc-500">
          Brief is Zod-validated before posting. AI output is Zod-validated server-side.
        </span>
      </div>
    </form>
  );

  // Parallel-runs hook. Re-uses the same brief shape; calls the new
  // /api/generate-campaign-variants endpoint which planters N times under
  // the hood with different diversity_seeds. After success we route to the
  // /campaign-variants/[bundle] page that lists all results side-by-side.
  function onGenerateVariants(count: number): void {
    setError(null);
    setIssues(null);
    const generated_asset_ids = generatedAssetIdsRaw
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const seedTrim = diversitySeedRaw.trim();
    const seedNum = seedTrim ? Number(seedTrim) : NaN;
    const brief: CampaignBriefInput = {
      brand_id: brandId,
      marketing_message: marketing_message.trim(),
      campaign_goal,
      tone,
      required_formats,
      preferred_contexts: preferred_contexts as CampaignBriefInput["preferred_contexts"],
      risk_warning_required,
      language,
      notes: notes.trim() || undefined,
      creative_mode: creativeMode,
      generated_asset_ids:
        generated_asset_ids.length > 0 ? generated_asset_ids : undefined,
      diversity_seed:
        Number.isFinite(seedNum) && seedNum >= 0 ? Math.floor(seedNum) : undefined,
      max_diversity: maxDiversity ? true : undefined,
      use_text_type_copy: useTextTypeCopy ? true : undefined,
    };
    const parsed = CampaignBriefInputSchema.safeParse(brief);
    if (!parsed.success) {
      setIssues(
        parsed.error.issues.map((i) => ({
          path: i.path.map(String).join("."),
          message: i.message,
        })),
      );
      return;
    }
    startTransition(async () => {
      try {
        const res = await fetch("/api/generate-campaign-variants", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            brief: parsed.data,
            ai_provider: provider,
            count,
            set_first_active: setActive,
          }),
        });
        const json = (await res.json()) as
          | { ok: true; variants: Array<{ campaign_id: string }> }
          | { ok: false; error: string; message?: string };
        if (!res.ok || !json.ok) {
          const j = json as { error: string; message?: string };
          setError(j.message ?? j.error ?? `HTTP ${res.status}`);
          return;
        }
        // Land on the campaigns index — operator can compare them there
        // (each variant is a regular saved campaign, just with its own
        // diversity_seed visible in the brief block).
        const ids = json.variants.map((v) => v.campaign_id).join(",");
        router.push(`/campaigns?variants=${ids}`);
      } catch (err) {
        setError((err as Error).message);
      }
    });
  }
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div>
        <span className="block text-sm font-medium">{label}</span>
        {hint && (
          <span className="block text-xs text-zinc-500">{hint}</span>
        )}
      </div>
      {children}
    </div>
  );
}

const inputCls =
  "w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500 dark:border-zinc-700 dark:bg-zinc-950";
const textareaCls = inputCls + " resize-y";
const smallBtnCls =
  "rounded-md border border-zinc-300 px-3 py-2 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800";

function pillCls(active: boolean): string {
  const base =
    "cursor-pointer select-none rounded-full border px-3 py-1 text-xs transition-colors";
  return active
    ? `${base} border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900`
    : `${base} border-zinc-300 text-zinc-700 hover:border-zinc-500 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-zinc-500`;
}
