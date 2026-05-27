"use client";

import { useState, useTransition } from "react";
import {
  ALL_CAMPAIGN_FORMATS,
  type CampaignDefaults,
  type CampaignPlannerDefaults,
} from "@/lib/settings/campaignDefaults.schema";
import type { CampaignFormat, HeadlineEmphasisStyle } from "@/lib/schemas/campaignBrief.schema";
import { LANG_META, type Language } from "@/lib/i18n/language";

interface Props {
  initialSettings: CampaignDefaults;
}

const sectionCls = "rounded-md border border-zinc-200 dark:border-zinc-800 p-4 space-y-3";
const labelCls = "text-xs font-medium uppercase tracking-wider text-zinc-500";
const inputCls =
  "w-full rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1 text-sm";
const textareaCls =
  "w-full rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1 text-sm";
const btnCls =
  "rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-1 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800";
const btnPrimaryCls =
  "rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50";

const GOAL_OPTIONS: Array<CampaignPlannerDefaults["campaign_goal"]> = [
  "awareness",
  "consideration",
  "conversion",
  "retention",
];

const HEADLINE_EMPHASIS_OPTIONS: Array<{
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

function linesToArray(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function pillCls(active: boolean): string {
  return [
    "inline-flex cursor-pointer items-center rounded-full border px-3 py-1 text-xs transition",
    active
      ? "border-blue-600 bg-blue-50 text-blue-700 dark:border-blue-400 dark:bg-blue-950/40 dark:text-blue-200"
      : "border-zinc-300 text-zinc-600 hover:border-zinc-500 dark:border-zinc-700 dark:text-zinc-300",
  ].join(" ");
}

export function CampaignDefaultsForm({ initialSettings }: Props) {
  const [settings, setSettings] = useState<CampaignDefaults>(initialSettings);
  const [status, setStatus] = useState<
    | { kind: "idle" }
    | { kind: "saving" }
    | { kind: "saved" }
    | { kind: "error"; message: string; issues?: { path: string; message: string }[] }
  >({ kind: "idle" });
  const [, startTransition] = useTransition();

  const planner = settings.campaign_planner;

  function patchPlanner(patch: Partial<CampaignPlannerDefaults>) {
    setSettings((prev) => ({
      ...prev,
      campaign_planner: {
        ...prev.campaign_planner,
        ...patch,
      },
    }));
  }

  function toggleFormat(format: CampaignFormat): void {
    const current = planner.required_formats;
    if (current.includes(format)) {
      if (current.length === 1) return;
      patchPlanner({ required_formats: current.filter((x) => x !== format) });
      return;
    }
    patchPlanner({ required_formats: [...current, format] });
  }

  function toggleLanguage(language: Language): void {
    const current = planner.output_languages;
    if (current.includes(language)) {
      if (current.length === 1) return;
      patchPlanner({ output_languages: current.filter((x) => x !== language) });
      return;
    }
    patchPlanner({ output_languages: [...current, language] });
  }

  function reset() {
    setSettings(initialSettings);
    setStatus({ kind: "idle" });
  }

  async function save() {
    setStatus({ kind: "saving" });
    startTransition(async () => {
      try {
        const res = await fetch("/api/campaign-defaults", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(settings),
        });
        const j = (await res.json()) as
          | { ok: true; settings: CampaignDefaults }
          | { ok: false; error: string; message?: string; issues?: { path: string; message: string }[] };
        if (!res.ok || !j.ok) {
          const err = j as {
            error: string;
            message?: string;
            issues?: { path: string; message: string }[];
          };
          setStatus({
            kind: "error",
            message: err.message ?? err.error ?? `HTTP ${res.status}`,
            issues: err.issues,
          });
          return;
        }
        setSettings(j.settings);
        setStatus({ kind: "saved" });
      } catch (e) {
        setStatus({ kind: "error", message: (e as Error).message });
      }
    });
  }

  return (
    <div className="space-y-5">
      <section className={sectionCls}>
        <h2 className="text-sm font-semibold">Campaign defaults</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <div className={labelCls}>marketing_message</div>
            <textarea
              value={planner.marketing_message}
              onChange={(e) => patchPlanner({ marketing_message: e.target.value })}
              rows={3}
              className={textareaCls}
            />
          </div>
          <div className="space-y-2">
            <div className={labelCls}>tone</div>
            <textarea
              value={planner.tone.join("\n")}
              onChange={(e) => patchPlanner({ tone: linesToArray(e.target.value) })}
              rows={3}
              className={textareaCls}
            />
          </div>
          <div className="space-y-2">
            <div className={labelCls}>campaign_goal</div>
            <select
              value={planner.campaign_goal}
              onChange={(e) =>
                patchPlanner({
                  campaign_goal: e.target.value as CampaignPlannerDefaults["campaign_goal"],
                })
              }
              className={inputCls}
            >
              {GOAL_OPTIONS.map((goal) => (
                <option key={goal} value={goal}>
                  {goal}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <div className={labelCls}>creative_mode</div>
            <select
              value={planner.creative_mode}
              onChange={(e) =>
                patchPlanner({
                  creative_mode: e.target.value as CampaignPlannerDefaults["creative_mode"],
                })
              }
              className={inputCls}
            >
              <option value="standard">standard</option>
              <option value="exploratory">exploratory</option>
            </select>
          </div>
        </div>
      </section>

      <section className={sectionCls}>
        <h2 className="text-sm font-semibold">Future banner formats</h2>
        <div className="flex flex-wrap gap-2">
          {ALL_CAMPAIGN_FORMATS.map((format) => (
            <label key={format} className={pillCls(planner.required_formats.includes(format))}>
              <input
                type="checkbox"
                className="sr-only"
                checked={planner.required_formats.includes(format)}
                onChange={() => toggleFormat(format)}
              />
              {format}
            </label>
          ))}
        </div>
      </section>

      <section className={sectionCls}>
        <h2 className="text-sm font-semibold">Output countries</h2>
        <div className="flex flex-wrap gap-2">
          {OUTPUT_COUNTRY_OPTIONS.map((option) => (
            <label
              key={option.language}
              className={pillCls(planner.output_languages.includes(option.language))}
            >
              <input
                type="checkbox"
                className="sr-only"
                checked={planner.output_languages.includes(option.language)}
                onChange={() => toggleLanguage(option.language)}
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
      </section>

      <section className={sectionCls}>
        <h2 className="text-sm font-semibold">Rendering behavior</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={planner.risk_warning_required}
              onChange={(e) => patchPlanner({ risk_warning_required: e.target.checked })}
            />
            risk_warning_required
          </label>
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={planner.auto_render}
              onChange={(e) => patchPlanner({ auto_render: e.target.checked })}
            />
            auto_render PNGs
          </label>
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={planner.set_active}
              onChange={(e) => patchPlanner({ set_active: e.target.checked })}
            />
            set first campaign active
          </label>
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={planner.max_diversity}
              onChange={(e) => patchPlanner({ max_diversity: e.target.checked })}
            />
            max_diversity
          </label>
        </div>
      </section>

      <section className={sectionCls}>
        <h2 className="text-sm font-semibold">Text treatment</h2>
        <div className="flex flex-wrap gap-2">
          {HEADLINE_EMPHASIS_OPTIONS.map((option) => (
            <label
              key={option.value}
              className={pillCls(planner.headline_emphasis_style === option.value)}
            >
              <input
                type="radio"
                name="default_headline_emphasis_style"
                className="sr-only"
                checked={planner.headline_emphasis_style === option.value}
                onChange={() => patchPlanner({ headline_emphasis_style: option.value })}
              />
              {option.label}
            </label>
          ))}
        </div>
      </section>

      <div className="sticky bottom-0 -mx-2 flex items-center gap-3 rounded-md border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900 sm:mx-0">
        <button
          type="button"
          onClick={save}
          disabled={status.kind === "saving"}
          className={btnPrimaryCls}
        >
          {status.kind === "saving" ? "Saving..." : "Save campaign defaults"}
        </button>
        <button type="button" onClick={reset} className={btnCls}>
          Reset
        </button>
        {status.kind === "saved" && (
          <span className="text-sm text-emerald-700 dark:text-emerald-400">
            Saved. New campaigns will use these defaults.
          </span>
        )}
        {status.kind === "error" && (
          <div className="space-y-1 text-sm text-amber-700 dark:text-amber-400">
            <div>{status.message}</div>
            {status.issues && status.issues.length > 0 && (
              <ul className="ml-4 list-disc text-xs">
                {status.issues.slice(0, 5).map((iss, i) => (
                  <li key={i}>
                    <code className="font-mono">{iss.path}</code>: {iss.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
