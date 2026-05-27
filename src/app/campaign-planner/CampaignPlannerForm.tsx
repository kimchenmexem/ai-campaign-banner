"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import {
  CampaignBriefInputSchema,
  type CampaignBriefInput,
  type CampaignFormat,
  type HeadlineEmphasisStyle,
} from "@/lib/schemas/campaignBrief.schema";
import { LANG_META, type Language } from "@/lib/i18n/language";
import {
  ALL_CAMPAIGN_FORMATS,
  type CampaignPlannerDefaults,
} from "@/lib/settings/campaignDefaults.schema";

// Form for /campaign-planner.
//
// State is managed locally; on submit we Zod-validate against
// CampaignBriefInputSchema (the same schema the API route validates) so the
// user sees field-level errors before we even hit the network. The API route
// re-validates as a defensive line.

type Provider = "mock" | "openai" | "anthropic";

const ALL_GOALS = ["awareness", "consideration", "conversion", "retention"] as const;
const TONE_SUGGESTIONS = [
  "confident",
  "trustworthy",
  "premium",
  "energetic",
  "analytical",
  "approachable",
];
const HEADLINE_EMPHASIS_STYLE_OPTIONS: Array<{
  value: HeadlineEmphasisStyle;
  label: string;
}> = [
  { value: "auto", label: "Auto mix" },
  { value: "accent_color", label: "Color split" },
  { value: "underline", label: "Underline" },
  { value: "outline", label: "Outline" },
  { value: "solid", label: "No split" },
];
const OUTPUT_COUNTRY_OPTIONS: Array<{
  countryName: string;
  language: Language;
}> = [
  { countryName: "United Kingdom", language: "en" },
  { countryName: "France", language: "fr" },
  { countryName: "Italy", language: "it" },
  { countryName: "Netherlands", language: "nl" },
  { countryName: "United Arab Emirates", language: "ar" },
  { countryName: "Israel", language: "he" },
];

interface Props {
  brandId: string;
  defaultProvider: Provider;
  initialDefaults: CampaignPlannerDefaults;
}

export function CampaignPlannerForm({
  brandId,
  defaultProvider,
  initialDefaults,
}: Props) {
  const router = useRouter();
  const [marketing_message, setMarketingMessage] = useState(
    initialDefaults.marketing_message,
  );
  const [campaign_goal, setCampaignGoal] = useState<typeof ALL_GOALS[number]>(
    initialDefaults.campaign_goal,
  );
  const [tone, setTone] = useState<string[]>(initialDefaults.tone);
  const [toneInput, setToneInput] = useState("");
  const [required_formats, setRequiredFormats] = useState<CampaignFormat[]>([
    ...initialDefaults.required_formats,
  ]);
  const [risk_warning_required, setRiskWarning] = useState(
    initialDefaults.risk_warning_required,
  );
  const [outputLanguages, setOutputLanguages] = useState<Language[]>(
    initialDefaults.output_languages,
  );
  const [notes, setNotes] = useState("");
  const [provider, setProvider] = useState<Provider>(defaultProvider);
  const [setActive, setSetActive] = useState(initialDefaults.set_active);
  const [autoRender, setAutoRender] = useState(initialDefaults.auto_render);
  // Step 12 — creative-mode hatch. "exploratory" gives the AI more freedom
  // (higher temperature, skips the critique pass that kills consultant-ese,
  // softer brand-discipline rules in the visual planner). The renderer's
  // safety clamps still apply, so layouts stay readable. Default off.
  const [creativeMode, setCreativeMode] = useState<"standard" | "exploratory">(
    initialDefaults.creative_mode,
  );
  // Phase 3 — generated-asset injection. Operator pastes asset ids from
  // /asset-generator (or /api/generators/registry); the planner resolves them
  // against data/generated-assets.generated.json. Empty/blank → no-op.
  const [generatedAssetIdsRaw, setGeneratedAssetIdsRaw] = useState("");
  const [headlineEmphasisStyle, setHeadlineEmphasisStyle] =
    useState<HeadlineEmphasisStyle>(initialDefaults.headline_emphasis_style);
  // Diversity controls — see CampaignBriefSchema. Empty seed = today's
  // behaviour (PRNG keyed off campaign_id only). Different seed = fresh
  // visual picks for the same brief. max_diversity is on by default so the
  // 3 concepts do not read like the same design with only copy swapped.
  const [diversitySeedRaw, setDiversitySeedRaw] = useState<string>("");
  const [maxDiversity, setMaxDiversity] = useState<boolean>(
    initialDefaults.max_diversity,
  );

  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<{ path: string; message: string }[] | null>(null);
  const [isPending, startTransition] = useTransition();
  // Live elapsed-time counter so the operator can see the run is still
  // moving — generation takes 90s on a clean run and up to several
  // minutes when an AI retry fires. A static "Generating…" label gives
  // no signal of life.
  const [elapsedMs, setElapsedMs] = useState(0);
  const generationStartRef = useRef<number | null>(null);
  // Real-time stage from the planner — set by the NDJSON stream reader
  // as the server emits onProgress events. Null while idle; the latest
  // stage label is shown under the button.
  const [stage, setStage] = useState<{ key: string; detail?: string } | null>(null);
  useEffect(() => {
    const resetId = window.setTimeout(() => {
      setElapsedMs(0);
      if (!isPending) setStage(null);
    }, 0);
    if (!isPending) {
      generationStartRef.current = null;
      return () => window.clearTimeout(resetId);
    }
    generationStartRef.current = Date.now();
    const id = window.setInterval(() => {
      if (generationStartRef.current != null) {
        setElapsedMs(Date.now() - generationStartRef.current);
      }
    }, 1000);
    return () => {
      window.clearTimeout(resetId);
      window.clearInterval(id);
    };
  }, [isPending]);
  const elapsedLabel = formatElapsed(elapsedMs);

  // Flag the browser tab when generation finishes while the operator is
  // looking at another tab — long runs (90s+) drive the operator away
  // and they have no way to tell from the tab strip that the run is
  // done. We swap document.title to a marker prefix on completion, then
  // restore it the next time the tab is brought back into focus. Done
  // outside onSubmit so the prefix survives the success-path redirect.
  const originalTitleRef = useRef<string | null>(null);
  function notifyTabTitle(prefix: string) {
    if (typeof document === "undefined") return;
    if (!document.hidden) return;
    if (originalTitleRef.current === null) {
      originalTitleRef.current = document.title;
    }
    document.title = `${prefix} ${originalTitleRef.current}`;
    const restore = () => {
      if (document.hidden) return;
      if (originalTitleRef.current !== null) {
        document.title = originalTitleRef.current;
        originalTitleRef.current = null;
      }
      document.removeEventListener("visibilitychange", restore);
    };
    document.addEventListener("visibilitychange", restore);
  }

  function toggle<T extends string>(arr: T[], v: T): T[] {
    return arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];
  }

  function toggleOutputLanguage(code: Language): void {
    setOutputLanguages((current) => {
      if (current.includes(code)) {
        return current.length > 1 ? current.filter((x) => x !== code) : current;
      }
      return [...current, code];
    });
  }

  function buildBrief(language: Language): CampaignBriefInput {
    const generated_asset_ids = generatedAssetIdsRaw
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const seedTrim = diversitySeedRaw.trim();
    const seedNum = seedTrim ? Number(seedTrim) : NaN;
    return {
      brand_id: brandId,
      marketing_message: marketing_message.trim(),
      campaign_goal,
      tone,
      required_formats,
      risk_warning_required,
      language,
      notes: notes.trim() || undefined,
      creative_mode: creativeMode,
      generated_asset_ids:
        generated_asset_ids.length > 0 ? generated_asset_ids : undefined,
      headline_emphasis_style: headlineEmphasisStyle,
      diversity_seed:
        Number.isFinite(seedNum) && seedNum >= 0 ? Math.floor(seedNum) : undefined,
      max_diversity: maxDiversity,
    };
  }

  function parseBriefs(): CampaignBriefInput[] | null {
    const parsedBriefs: CampaignBriefInput[] = [];
    const validationIssues: { path: string; message: string }[] = [];
    for (const outputLanguage of outputLanguages) {
      const parsed = CampaignBriefInputSchema.safeParse(buildBrief(outputLanguage));
      if (parsed.success) {
        parsedBriefs.push(parsed.data);
        continue;
      }
      const prefix = outputCountryName(outputLanguage);
      validationIssues.push(
        ...parsed.error.issues.map((i) => ({
          path: `${prefix}.${i.path.map(String).join(".")}`,
          message: i.message,
        })),
      );
    }
    if (validationIssues.length > 0 || parsedBriefs.length === 0) {
      setIssues(
        validationIssues.length > 0
          ? validationIssues
          : [{ path: "language", message: "Select at least one output language." }],
      );
      return null;
    }
    return parsedBriefs;
  }

  function languageRunDetail(
    outputLanguage: Language,
    index: number,
    total: number,
    detail?: string,
  ): string {
    const prefix =
      total > 1
        ? `${index + 1}/${total} · ${outputCountryName(outputLanguage)}`
        : outputCountryName(outputLanguage);
    return detail ? `${prefix} · ${detail}` : prefix;
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setIssues(null);

    const parsedBriefs = parseBriefs();
    if (!parsedBriefs) return;

    startTransition(async () => {
      try {
        const campaignIds: string[] = [];
        for (let i = 0; i < parsedBriefs.length; i++) {
          const brief = parsedBriefs[i];
          setStage({
            key: "language",
            detail: languageRunDetail(brief.language, i, parsedBriefs.length),
          });
          const res = await fetch("/api/generate-campaign", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              // Opt into the streaming response — the route emits NDJSON
              // stage events the form renders below the button. Without
              // this header the route falls back to its legacy synchronous
              // single-JSON response (still works, no progress info).
              Accept: "application/x-ndjson",
            },
            body: JSON.stringify({
              brief,
              ai_provider: provider,
              set_as_active: setActive && i === 0,
            }),
          });
          const terminal = await readPlannerStream(res, (ev) => {
            if (ev.type === "stage") {
              setStage({
                key: ev.stage,
                detail: languageRunDetail(
                  brief.language,
                  i,
                  parsedBriefs.length,
                  ev.detail,
                ),
              });
            }
          });
          if (!terminal || !terminal.ok) {
            setError(
              `${outputCountryName(brief.language)}: ${
                terminal?.message ?? terminal?.error ?? `HTTP ${res.status}`
              }`,
            );
            notifyTabTitle("✗");
            return;
          }
          campaignIds.push(terminal.campaign_id);
          // Optionally render PNGs before redirecting so the campaign page
          // shows the rendered banners on first load. Synchronous (~30s) but
          // it's the difference between "I got nothing" and "here are 9 PNGs."
          if (autoRender) {
            setStage({
              key: "rendering",
              detail: languageRunDetail(brief.language, i, parsedBriefs.length),
            });
            await renderCampaignPngs(terminal.campaign_id);
          }
        }
        notifyTabTitle("✓");
        router.push(
          campaignIds.length === 1
            ? `/campaigns/${campaignIds[0]}`
            : `/campaigns?generated=${campaignIds.join(",")}`,
        );
      } catch (err) {
        setError((err as Error).message);
        notifyTabTitle("✗");
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
          {ALL_CAMPAIGN_FORMATS.map((f) => (
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
        label="Output countries"
        hint="Choose one or more target countries. The system creates one localized campaign per country and uses the matching copy language, disclaimer, RTL alignment, CTA arrow, and font rendering."
      >
        <div className="flex flex-wrap gap-2">
          {OUTPUT_COUNTRY_OPTIONS.map((option) => (
            <label
              key={option.language}
              className={pillCls(outputLanguages.includes(option.language))}
            >
              <input
                type="checkbox"
                className="sr-only"
                checked={outputLanguages.includes(option.language)}
                onChange={() => toggleOutputLanguage(option.language)}
              />
              <span className="flex flex-col leading-tight">
                <span>{option.countryName}</span>
                <span className="text-[10px] opacity-75">
                  {LANG_META[option.language].nativeName}
                </span>
              </span>
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

      <Field
        label="Headline emphasis"
        hint="Changes only the visual treatment of the existing headline prefix. Font, size, line-height, and layout stay exactly the same."
      >
        <div className="flex flex-wrap gap-2">
          {HEADLINE_EMPHASIS_STYLE_OPTIONS.map((option) => (
            <label
              key={option.value}
              className={pillCls(headlineEmphasisStyle === option.value)}
            >
              <input
                type="radio"
                name="headline_emphasis_style"
                className="sr-only"
                checked={headlineEmphasisStyle === option.value}
                onChange={() => setHeadlineEmphasisStyle(option.value)}
              />
              {option.label}
            </label>
          ))}
        </div>
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
          </select>
        </Field>

        <Field label="Set as active campaign">
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={setActive}
              onChange={(e) => setSetActive(e.target.checked)}
            />
            Visual Preview / Code Render will load the first selected language
          </label>
        </Field>
      </div>

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
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
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
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
          {error}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={isPending}
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          {isPending
            ? `Generating… ${elapsedLabel}`
            : outputLanguages.length > 1
              ? `Generate ${outputLanguages.length} campaigns`
              : "Generate campaign"}
        </button>
        <button
          type="button"
          disabled={isPending}
          onClick={() => onGenerateVariants(3)}
          className="rounded-md border border-zinc-900 bg-white px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-100 dark:bg-zinc-950 dark:text-zinc-100 dark:hover:bg-zinc-900"
          title="Run the same brief 3 times with 3 different diversity seeds. Costs ~3× tokens."
        >
          {isPending
            ? `Generating… ${elapsedLabel}`
            : outputLanguages.length > 1
              ? `Generate 3 variants / language`
              : "Generate 3 variants"}
        </button>
        <span className="text-xs text-zinc-500">
          Brief is Zod-validated before posting. AI output is Zod-validated server-side.
        </span>
      </div>

      {isPending && stage && (
        <div className="flex items-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
          <span
            className="inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-500"
            aria-hidden="true"
          />
          <span>{stageLabel(stage.key, stage.detail)}…</span>
          <span className="ml-auto font-mono text-xs text-zinc-500">
            {elapsedLabel}
          </span>
        </div>
      )}
    </form>
  );

  // Parallel-runs hook. Re-uses the same brief shape; calls the new
  // /api/generate-campaign-variants endpoint which planters N times under
  // the hood with different diversity_seeds. After success we route to the
  // /campaign-variants/[bundle] page that lists all results side-by-side.
  function onGenerateVariants(count: number): void {
    setError(null);
    setIssues(null);
    const parsedBriefs = parseBriefs();
    if (!parsedBriefs) return;
    startTransition(async () => {
      try {
        const allVariants: Array<{ campaign_id: string }> = [];
        for (let i = 0; i < parsedBriefs.length; i++) {
          const brief = parsedBriefs[i];
          setStage({
            key: "language",
            detail: languageRunDetail(brief.language, i, parsedBriefs.length),
          });
          const res = await fetch("/api/generate-campaign-variants", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/x-ndjson",
            },
            body: JSON.stringify({
              brief,
              ai_provider: provider,
              count,
              set_first_active: setActive && i === 0,
            }),
          });
          const terminal = await readVariantsStream(res, (ev) => {
            if (ev.type === "stage") {
              const variantDetail = ev.detail
                ? `variant ${ev.variant}/${ev.of} · ${ev.detail}`
                : `variant ${ev.variant}/${ev.of}`;
              setStage({
                key: ev.stage,
                detail: languageRunDetail(
                  brief.language,
                  i,
                  parsedBriefs.length,
                  variantDetail,
                ),
              });
            }
          });
          if (!terminal || !terminal.ok) {
            setError(
              `${outputCountryName(brief.language)}: ${
                terminal?.message ?? terminal?.error ?? `HTTP ${res.status}`
              }`,
            );
            notifyTabTitle("✗");
            return;
          }
          allVariants.push(...terminal.variants);
          if (terminal.errors.length > 0) {
            setError(
              `${outputCountryName(brief.language)}: ${terminal.errors.length} variant(s) failed; saved the successful ones.`,
            );
          }
        }
        if (allVariants.length === 0) {
          setError("No variants were generated.");
          notifyTabTitle("✗");
          return;
        }
        notifyTabTitle("✓");
        // Land on the campaigns index — operator can compare them there
        // (each variant is a regular saved campaign, just with its own
        // diversity_seed visible in the brief block).
        const ids = allVariants.map((v) => v.campaign_id).join(",");
        router.push(`/campaigns?variants=${ids}`);
      } catch (err) {
        setError((err as Error).message);
        notifyTabTitle("✗");
      }
    });
  }
}

// Format an elapsed duration as "Ns" while < 60s, "M:SS" once we cross
// the minute mark. Generation hits the minute mark by design, so M:SS is
// the dominant view; under-60s formatting keeps fresh runs feeling quick.
function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function outputCountryName(language: Language): string {
  return (
    OUTPUT_COUNTRY_OPTIONS.find((option) => option.language === language)
      ?.countryName ?? LANG_META[language].nativeName
  );
}

// Planner auto-render is a convenience, not the source of truth. If headless
// Chromium gets slow, the saved campaign should still open; the campaign page
// has its own "Render PNGs now" retry button.
async function renderCampaignPngs(campaignId: string): Promise<void> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 75_000);
  try {
    await fetch("/api/render-campaign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ campaign_id: campaignId }),
      signal: controller.signal,
    });
  } catch {
    // Non-fatal — the campaign detail page can re-render PNGs.
  } finally {
    window.clearTimeout(timeout);
  }
}

// Events the planner stream emits. `stage` events fire each phase
// boundary; the terminal `done` event carries the success payload OR
// an error, and is always the last line of the stream.
type StageEvent = { type: "stage"; stage: string; detail?: string };
type DoneEvent =
  | { type: "done"; ok: true; campaign_id: string; plan?: unknown }
  | { type: "done"; ok: false; error: string; message?: string };
type PlannerEvent = StageEvent | DoneEvent;

// Read an NDJSON response body line-by-line, invoking onEvent for each
// stage and returning the terminal `done` event. Carries a partial-line
// buffer because a chunk can split mid-line. Returns null only if the
// stream closed without emitting a terminal event (treated as error by
// the caller).
async function readPlannerStream(
  res: Response,
  onEvent: (ev: StageEvent) => void,
): Promise<Extract<DoneEvent, { type: "done" }> | null> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let terminal: Extract<DoneEvent, { type: "done" }> | null = null;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf("\n");
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as PlannerEvent;
        if (parsed.type === "stage") onEvent(parsed);
        else if (parsed.type === "done") terminal = parsed;
      } catch {
        // Malformed line — skip. The route only emits objects we control,
        // so this should never happen; defensive guard for proxies that
        // inject text into the stream.
      }
    }
  }
  return terminal;
}

// Variants stream — same shape as the single-campaign stream, but stage
// events carry `variant` (1-based) + `of` so the UI can render
// "variant 2/3 — translating concept 1 of 3". The terminal event
// returns the list of saved variant campaign_ids (and per-variant
// errors, if any).
type VariantStageEvent = {
  type: "stage";
  variant: number;
  of: number;
  stage: string;
  detail?: string;
};
type VariantPerDoneEvent =
  | { type: "variant_done"; ok: true; variant: number; of: number; campaign_id: string; campaign_name: string; diversity_seed: number }
  | { type: "variant_done"; ok: false; variant: number; of: number; message: string };
type VariantsDoneEvent =
  | {
      type: "done";
      ok: true;
      base_seed: number;
      variants: Array<{ campaign_id: string; campaign_name: string; diversity_seed: number; saved_path: string }>;
      errors: Array<{ index: number; message: string }>;
    }
  | {
      type: "done";
      ok: false;
      error: string;
      message?: string;
      variants: Array<{ campaign_id: string; campaign_name: string; diversity_seed: number; saved_path: string }>;
      errors: Array<{ index: number; message: string }>;
    };
type VariantsEvent = VariantStageEvent | VariantPerDoneEvent | VariantsDoneEvent;

async function readVariantsStream(
  res: Response,
  onEvent: (ev: VariantStageEvent | VariantPerDoneEvent) => void,
): Promise<Extract<VariantsDoneEvent, { type: "done" }> | null> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let terminal: Extract<VariantsDoneEvent, { type: "done" }> | null = null;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf("\n");
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as VariantsEvent;
        if (parsed.type === "stage" || parsed.type === "variant_done") {
          onEvent(parsed);
        } else if (parsed.type === "done") {
          terminal = parsed;
        }
      } catch {
        // Skip malformed line — same defensive guard as readPlannerStream.
      }
    }
  }
  return terminal;
}

// Map a planner stage key to a short human label shown under the button.
// Unknown keys (e.g. the client-side "rendering" pseudo-stage) fall
// through to a title-cased version of the key.
function stageLabel(key: string, detail?: string): string {
  const base: Record<string, string> = {
    ai_concepts: "Generating concepts",
    refining: "Refining copy",
    translating: "Translating",
    images: "Preparing optional imagery",
    visual_planning: "Planning visual layouts",
    building: "Building banner layouts",
    qa: "Running position QA",
    saving: "Saving campaign",
    language: "Generating language output",
    rendering: "Rendering banner PNGs",
  };
  const text = base[key] ?? key.replace(/_/g, " ");
  return detail ? `${text} — ${detail}` : text;
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
