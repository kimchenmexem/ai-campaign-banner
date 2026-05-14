"use client";

import { useState, useTransition } from "react";
import type { BrandKitLite } from "@/lib/schemas/brandKit.schema";

interface Props {
  initialKit: BrandKitLite;
}

const sectionCls = "rounded-md border border-zinc-200 dark:border-zinc-800 p-4 space-y-3";
const labelCls = "text-xs font-medium uppercase tracking-wider text-zinc-500";
const inputCls =
  "w-full rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1 text-sm font-mono";
const textareaCls =
  "w-full rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1 text-sm";
const btnCls =
  "rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-1 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800";
const btnPrimaryCls =
  "rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50";

function HexInput({
  value,
  onChange,
  onRemove,
}: {
  value: string;
  onChange: (v: string) => void;
  onRemove?: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="color"
        value={/^#[0-9a-fA-F]{6}$/.test(value) ? value : "#000000"}
        onChange={(e) => onChange(e.target.value.toUpperCase())}
        className="h-7 w-9 rounded border border-zinc-300 dark:border-zinc-700"
        aria-label="color picker"
      />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`${inputCls} w-28`}
        placeholder="#000000"
      />
      {onRemove && (
        <button type="button" onClick={onRemove} className={btnCls} aria-label="remove">
          ×
        </button>
      )}
    </div>
  );
}

function ColorArray({
  label,
  values,
  onChange,
}: {
  label: string;
  values: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <div className="space-y-2">
      <div className={labelCls}>{label}</div>
      <div className="space-y-2">
        {values.map((v, i) => (
          <HexInput
            key={i}
            value={v}
            onChange={(x) => onChange(values.map((y, j) => (i === j ? x : y)))}
            onRemove={
              // primary[] requires .min(1) — refuse to remove the last entry there
              label === "primary" && values.length === 1
                ? undefined
                : () => onChange(values.filter((_, j) => i !== j))
            }
          />
        ))}
        <button
          type="button"
          onClick={() => onChange([...values, "#000000"])}
          className={btnCls}
        >
          + add color
        </button>
      </div>
    </div>
  );
}

export function BrandKitForm({ initialKit }: Props) {
  const [kit, setKit] = useState<BrandKitLite>(initialKit);
  const [status, setStatus] = useState<
    | { kind: "idle" }
    | { kind: "saving" }
    | { kind: "saved" }
    | { kind: "error"; message: string; issues?: { path: string; message: string }[] }
  >({ kind: "idle" });
  const [, startTransition] = useTransition();

  function patchColors(patch: Partial<BrandKitLite["colors"]>) {
    setKit((prev) => ({ ...prev, colors: { ...prev.colors, ...patch } }));
  }

  function patchCta(patch: Partial<BrandKitLite["cta"]>) {
    setKit((prev) => ({ ...prev, cta: { ...prev.cta, ...patch } }));
  }

  function patchVariant(index: number, patch: Partial<NonNullable<BrandKitLite["cta"]["variants"]>[number]>) {
    setKit((prev) => ({
      ...prev,
      cta: {
        ...prev.cta,
        variants: (prev.cta.variants ?? []).map((v, i) => (i === index ? { ...v, ...patch } : v)),
      },
    }));
  }

  function patchLegal(patch: Partial<BrandKitLite["legal"]>) {
    setKit((prev) => ({ ...prev, legal: { ...prev.legal, ...patch } }));
  }

  function reset() {
    setKit(initialKit);
    setStatus({ kind: "idle" });
  }

  async function save() {
    setStatus({ kind: "saving" });
    startTransition(async () => {
      try {
        const res = await fetch("/api/brand-kit", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(kit),
        });
        const j = (await res.json()) as
          | { ok: true }
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
        setStatus({ kind: "saved" });
      } catch (e) {
        setStatus({ kind: "error", message: (e as Error).message });
      }
    });
  }

  return (
    <div className="space-y-5">
      {/* ── Colors ─────────────────────────────────────────── */}
      <section className={sectionCls}>
        <h2 className="text-sm font-semibold">Colors</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <ColorArray
            label="primary"
            values={kit.colors.primary}
            onChange={(v) => patchColors({ primary: v })}
          />
          <ColorArray
            label="background"
            values={kit.colors.background}
            onChange={(v) => patchColors({ background: v })}
          />
          <ColorArray
            label="accent"
            values={kit.colors.accent}
            onChange={(v) => patchColors({ accent: v })}
          />
        </div>
      </section>

      {/* ── Disclaimer / Legal ─────────────────────────────── */}
      <section className={sectionCls}>
        <h2 className="text-sm font-semibold">Disclaimer (legal copy)</h2>
        <div className="space-y-2">
          <div className={labelCls}>default_disclaimer</div>
          <textarea
            value={kit.legal.default_disclaimer}
            onChange={(e) => patchLegal({ default_disclaimer: e.target.value })}
            rows={3}
            className={textareaCls}
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className={labelCls}>min_disclaimer_font_size</div>
            <input
              type="number"
              min={8}
              value={kit.legal.min_disclaimer_font_size ?? ""}
              onChange={(e) =>
                patchLegal({
                  min_disclaimer_font_size: e.target.value ? Number(e.target.value) : undefined,
                })
              }
              className={inputCls}
            />
          </div>
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="risk-required"
              checked={kit.legal.risk_warning_required ?? true}
              onChange={(e) => patchLegal({ risk_warning_required: e.target.checked })}
            />
            <label htmlFor="risk-required" className="text-sm">
              risk_warning_required
            </label>
          </div>
        </div>
      </section>

      {/* ── CTA defaults ──────────────────────────────────── */}
      <section className={sectionCls}>
        <h2 className="text-sm font-semibold">CTA defaults</h2>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <div className={labelCls}>button_background_color</div>
            <HexInput
              value={kit.cta.button_background_color}
              onChange={(v) => patchCta({ button_background_color: v })}
            />
          </div>
          <div className="space-y-2">
            <div className={labelCls}>button_text_color</div>
            <HexInput
              value={kit.cta.button_text_color}
              onChange={(v) => patchCta({ button_text_color: v })}
            />
          </div>
        </div>
      </section>

      {/* ── CTA variants ──────────────────────────────────── */}
      <section className={sectionCls}>
        <h2 className="text-sm font-semibold">CTA variants</h2>
        <p className="text-xs text-zinc-500">
          The contrast guard (PR 3516fa9) picks among these at render time, preferring whichever
          stays ≥ 3:1 against the canvas background. Editing values here changes what the guard
          can fall back to.
        </p>
        <div className="space-y-3">
          {(kit.cta.variants ?? []).map((v, i) => (
            <div key={v.id ?? i} className="rounded border border-zinc-200 dark:border-zinc-800 p-3 space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-xs font-mono text-zinc-500">id: {v.id}</div>
                <div className="text-xs text-zinc-400">{v.name ?? ""}</div>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <div className="space-y-1">
                  <div className={labelCls}>background_color</div>
                  <HexInput
                    value={v.background_color}
                    onChange={(x) => patchVariant(i, { background_color: x })}
                  />
                </div>
                <div className="space-y-1">
                  <div className={labelCls}>text_color</div>
                  <HexInput
                    value={v.text_color}
                    onChange={(x) => patchVariant(i, { text_color: x })}
                  />
                </div>
                <div className="space-y-1">
                  <div className={labelCls}>border_radius</div>
                  <input
                    type="number"
                    min={0}
                    value={v.border_radius ?? 0}
                    onChange={(e) =>
                      patchVariant(i, { border_radius: Number(e.target.value) })
                    }
                    className={inputCls}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Save / status bar ─────────────────────────────── */}
      <div className="sticky bottom-0 -mx-2 sm:mx-0 flex items-center gap-3 rounded-md border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 p-3">
        <button
          type="button"
          onClick={save}
          disabled={status.kind === "saving"}
          className={btnPrimaryCls}
        >
          {status.kind === "saving" ? "Saving…" : "Save brand kit"}
        </button>
        <button type="button" onClick={reset} className={btnCls}>
          Reset
        </button>
        {status.kind === "saved" && (
          <span className="text-sm text-emerald-700 dark:text-emerald-400">
            ✓ Saved — next campaign render will use the new values.
          </span>
        )}
        {status.kind === "error" && (
          <div className="text-sm text-red-700 dark:text-red-400 space-y-1">
            <div>✗ {status.message}</div>
            {status.issues && status.issues.length > 0 && (
              <ul className="ml-4 text-xs list-disc">
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
