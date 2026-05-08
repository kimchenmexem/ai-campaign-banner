"use client";

import { useEffect, useMemo, useState } from "react";
import type {
  BrandInputAsset,
  GeneratedAsset,
  GeneratedAssetType,
  GeneratorRegistryEntry,
  SourceMode,
} from "@/lib/schemas/generatedAsset.schema";

// ─────────────────────────────────────────────────────────────────────────────
// AssetGeneratorTabs — five-tab UI driving the /api/generators/* endpoints.
// Each tab exposes:
//   - generator-specific params (variant, size, text, etc.)
//   - source_mode selector (when the registry advertises >1 mode)
//   - output_mode selector (CTA: element | svg)
//   - brand-input picker (loaded from /api/generators/brand-input-assets?for=…)
//   - generate button
//   - recent gallery (with delete + provenance + element_manifest_preview view)
// ─────────────────────────────────────────────────────────────────────────────

interface Props {
  registry: GeneratorRegistryEntry[];
  initialRecent: GeneratedAsset[];
  // Phase 4 — id → list of campaign ids that reference the asset.
  initialUsage?: Record<string, string[]>;
}

type TabId = GeneratedAssetType;

export function AssetGeneratorTabs({ registry, initialRecent, initialUsage }: Props) {
  const [activeTab, setActiveTab] = useState<TabId>("background");
  const [recent, setRecent] = useState<GeneratedAsset[]>(initialRecent);
  const [usage, setUsage] = useState<Record<string, string[]>>(initialUsage ?? {});

  const handleAssetCreated = (asset: GeneratedAsset) => {
    setRecent((prev) => [asset, ...prev]);
  };

  const handleAssetDeleted = (id: string) => {
    setRecent((prev) => prev.filter((a) => a.id !== id));
    setUsage((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const handleAssetUpdated = (asset: GeneratedAsset) => {
    setRecent((prev) => prev.map((a) => (a.id === asset.id ? asset : a)));
  };

  return (
    <div className="space-y-6">
      <nav className="flex flex-wrap gap-2 border-b border-zinc-200 dark:border-zinc-800">
        {registry.map((g) => (
          <button
            key={g.id}
            type="button"
            onClick={() => setActiveTab(g.type)}
            className={
              activeTab === g.type
                ? "border-b-2 border-zinc-900 px-3 py-2 text-sm font-medium text-zinc-900 dark:border-zinc-100 dark:text-zinc-100"
                : "px-3 py-2 text-sm text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
            }
          >
            {g.label}
          </button>
        ))}
      </nav>

      {registry.map(
        (g) =>
          g.type === activeTab && (
            <GeneratorPanel
              key={g.id}
              entry={g}
              recent={recent.filter((a) => a.type === g.type)}
              usage={usage}
              onAssetCreated={handleAssetCreated}
              onAssetDeleted={handleAssetDeleted}
              onAssetUpdated={handleAssetUpdated}
            />
          ),
      )}
    </div>
  );
}

// ── Panel ─────────────────────────────────────────────────────────────────
interface GeneratorPanelProps {
  entry: GeneratorRegistryEntry;
  recent: GeneratedAsset[];
  usage: Record<string, string[]>;
  onAssetCreated: (asset: GeneratedAsset) => void;
  onAssetDeleted: (id: string) => void;
  onAssetUpdated: (asset: GeneratedAsset) => void;
}

function GeneratorPanel({
  entry,
  recent,
  usage,
  onAssetCreated,
  onAssetDeleted,
  onAssetUpdated,
}: GeneratorPanelProps) {
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,400px),1fr]">
      <div className="space-y-3 rounded-md border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">{entry.description}</p>
        {/* Re-mount the form on tab switch so useState defaults reset cleanly. */}
        <GeneratorForm key={entry.id} entry={entry} onAssetCreated={onAssetCreated} />
        <PlacementRulesSummary entry={entry} />
      </div>
      <div className="space-y-2">
        <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          Recent {entry.label.toLowerCase()}
        </h2>
        <RecentGallery
          assets={recent}
          usage={usage}
          onAssetDeleted={onAssetDeleted}
          onAssetUpdated={onAssetUpdated}
        />
      </div>
    </div>
  );
}

// ── Form ──────────────────────────────────────────────────────────────────
function GeneratorForm({
  entry,
  onAssetCreated,
}: {
  entry: GeneratorRegistryEntry;
  onAssetCreated: (asset: GeneratedAsset) => void;
}) {
  const [variant, setVariant] = useState<string>(entry.variants[0]);
  const [width, setWidth] = useState<number>(entry.default_size.width);
  const [height, setHeight] = useState<number>(entry.default_size.height);
  const [text, setText] = useState<string>("Start trading");
  const [ticker, setTicker] = useState<string>("AAPL");
  const [seed, setSeed] = useState<string>("");
  const [intensity, setIntensity] = useState<number>(0.5);
  const [angle, setAngle] = useState<number>(135);
  const [device, setDevice] = useState<string>("phone");
  const [sourceMode, setSourceMode] = useState<SourceMode>(entry.default_source_mode);
  const [outputMode, setOutputMode] = useState<string>(entry.default_output_mode);
  const [overlayMode, setOverlayMode] = useState<"replace" | "scrim" | "tint">("scrim");
  const [overlayOpacity, setOverlayOpacity] = useState<number>(0.55);
  const [arrow, setArrow] = useState<"none" | "auto" | "ltr" | "rtl">("none");
  // Brand-input picks per tab.
  const [brandInputAssets, setBrandInputAssets] = useState<BrandInputAsset[]>([]);
  const [pickedBackground, setPickedBackground] = useState<string>("");
  const [pickedMockup, setPickedMockup] = useState<string>("");
  const [pickedScreenshot, setPickedScreenshot] = useState<string>("");
  const [pickedFxElement, setPickedFxElement] = useState<string>("");

  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Load brand-input picker payload when the tab needs it. Form is keyed on
  // entry.id, so this effect runs once on mount per tab — no setState-on-tab-
  // change anti-pattern needed.
  useEffect(() => {
    if (entry.brand_input_folders.length === 0) return;
    let cancelled = false;
    fetch(`/api/generators/brand-input-assets?for=${entry.type}`)
      .then((r) => r.json())
      .then((j: { ok: boolean; assets: BrandInputAsset[] }) => {
        if (!cancelled && j.ok) setBrandInputAssets(j.assets);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [entry.type, entry.brand_input_folders.length]);

  const backgroundOptions = useMemo(
    () => brandInputAssets.filter((a) => a.canonical_folder_type === "backgrounds" || a.canonical_folder_type === "elements"),
    [brandInputAssets],
  );
  const mockupOptions = useMemo(
    () =>
      brandInputAssets.filter(
        (a) =>
          a.canonical_folder_type === "mockups" &&
          (!device || a.device_type === device || !a.device_type),
      ),
    [brandInputAssets, device],
  );
  const screenshotOptions = useMemo(
    () => brandInputAssets.filter((a) => a.canonical_folder_type === "platform_screenshots"),
    [brandInputAssets],
  );
  const fxElementOptions = useMemo(
    () => brandInputAssets.filter((a) => a.canonical_folder_type === "elements" || a.canonical_folder_type === "backgrounds"),
    [brandInputAssets],
  );

  const buildBody = (): Record<string, unknown> => {
    const seedNum = seed ? Number(seed) : undefined;
    switch (entry.type) {
      case "background":
        return {
          variant,
          size: { width, height },
          source_mode: sourceMode,
          brand_input_background_path: pickedBackground || undefined,
          overlay_mode: overlayMode,
          overlay_opacity: overlayOpacity,
          angle_deg: angle,
          seed: Number.isFinite(seedNum) ? seedNum : undefined,
        };
      case "cta":
        return {
          variant,
          text,
          size: { width, height },
          output_mode: outputMode,
          arrow,
        };
      case "mockup":
        return {
          device,
          mockup_path: pickedMockup || undefined,
          screenshot_path: pickedScreenshot || "/brand-input-preview/Order dialog (Light).png",
          source_mode: sourceMode,
        };
      case "trading_ui":
        return {
          variant,
          size: { width, height },
          ticker,
          seed: Number.isFinite(seedNum) ? seedNum : undefined,
        };
      case "fx_overlay":
        return {
          variant,
          size: { width, height },
          intensity,
          source_mode: sourceMode,
          brand_input_element_paths: pickedFxElement ? [pickedFxElement] : [],
          seed: Number.isFinite(seedNum) ? seedNum : undefined,
        };
    }
  };

  const submit = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch(entry.api_path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildBody()),
      });
      const json = (await res.json()) as
        | { ok: true; asset: GeneratedAsset }
        | { ok: false; error: string; message?: string; issues?: unknown };
      if (!json.ok) {
        const msg =
          "message" in json && typeof json.message === "string"
            ? json.message
            : json.error;
        setError(msg);
        return;
      }
      onAssetCreated(json.asset);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const isMockup = entry.type === "mockup";
  const showTextField = entry.type === "cta";
  const showTicker = entry.type === "trading_ui";
  const showAngle = entry.type === "background" && variant === "linear_gradient";
  const showIntensity = entry.type === "fx_overlay";
  const showSeed =
    entry.type === "background" || entry.type === "trading_ui" || entry.type === "fx_overlay";

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {!isMockup && (
        <Field label="Variant">
          <select
            value={variant}
            onChange={(e) => setVariant(e.target.value)}
            className="w-full rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          >
            {entry.variants.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </Field>
      )}

      {isMockup && (
        <Field label="Device">
          <select
            value={device}
            onChange={(e) => setDevice(e.target.value)}
            className="w-full rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          >
            {entry.variants.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </Field>
      )}

      {/* Source mode selector — only show when the generator advertises >1. */}
      {entry.source_modes.length > 1 && (
        <Field label="Source mode">
          <select
            value={sourceMode}
            onChange={(e) => setSourceMode(e.target.value as SourceMode)}
            className="w-full rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          >
            {entry.source_modes.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </Field>
      )}

      {/* Output mode (CTA only). */}
      {entry.output_modes.length > 1 && (
        <Field label="Output mode">
          <select
            value={outputMode}
            onChange={(e) => setOutputMode(e.target.value)}
            className="w-full rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          >
            {entry.output_modes.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </Field>
      )}

      {/* Background brand-input picker. */}
      {entry.type === "background" && sourceMode !== "generated_only" && (
        <>
          <Field label="Brand-input background">
            <BrandInputSelect
              options={backgroundOptions}
              value={pickedBackground}
              onChange={setPickedBackground}
              placeholder="(none — pick a file)"
            />
          </Field>
          <Field label="Overlay mode">
            <select
              value={overlayMode}
              onChange={(e) => setOverlayMode(e.target.value as "replace" | "scrim" | "tint")}
              className="w-full rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            >
              <option value="scrim">scrim — generated layer at opacity</option>
              <option value="tint">tint — solid first-color tint</option>
              <option value="replace">replace — image only</option>
            </select>
          </Field>
          {overlayMode !== "replace" && (
            <Field label={`Overlay opacity (${overlayOpacity.toFixed(2)})`}>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={overlayOpacity}
                onChange={(e) => setOverlayOpacity(Number(e.target.value))}
                className="w-full"
              />
            </Field>
          )}
        </>
      )}

      {/* Mockup pickers. */}
      {isMockup && (
        <>
          <Field label="Mockup device file (brand-input/mockup devices/)">
            <BrandInputSelect
              options={mockupOptions}
              value={pickedMockup}
              onChange={setPickedMockup}
              placeholder="(auto — pick by device hint)"
            />
          </Field>
          <Field label="Screenshot file (brand-input/Platform screenshot/)">
            <BrandInputSelect
              options={screenshotOptions}
              value={pickedScreenshot}
              onChange={setPickedScreenshot}
              placeholder="(default — Order dialog)"
            />
          </Field>
        </>
      )}

      {/* FX overlay element picker. */}
      {entry.type === "fx_overlay" && sourceMode !== "generated_only" && (
        <Field label="Brand-input element to layer over">
          <BrandInputSelect
            options={fxElementOptions}
            value={pickedFxElement}
            onChange={setPickedFxElement}
            placeholder="(none — overlay on transparent canvas)"
          />
        </Field>
      )}

      {!isMockup && (
        <div className="grid grid-cols-2 gap-2">
          <Field label="Width">
            <input
              type="number"
              value={width}
              min={64}
              max={4096}
              onChange={(e) => setWidth(Number(e.target.value))}
              className="w-full rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
          </Field>
          <Field label="Height">
            <input
              type="number"
              value={height}
              min={64}
              max={4096}
              onChange={(e) => setHeight(Number(e.target.value))}
              className="w-full rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
          </Field>
        </div>
      )}

      {showTextField && (
        <>
          <Field label="Button text">
            <input
              type="text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={48}
              className="w-full rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
          </Field>
          <Field label="Arrow">
            <select
              value={arrow}
              onChange={(e) => setArrow(e.target.value as "none" | "auto" | "ltr" | "rtl")}
              className="w-full rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            >
              <option value="none">none</option>
              <option value="auto">auto (LTR-leading)</option>
              <option value="ltr">ltr — text › arrow</option>
              <option value="rtl">rtl — arrow ‹ text</option>
            </select>
          </Field>
        </>
      )}

      {showTicker && (
        <Field label="Ticker">
          <input
            type="text"
            value={ticker}
            onChange={(e) => setTicker(e.target.value.toUpperCase())}
            maxLength={8}
            className="w-full rounded border border-zinc-300 bg-white px-2 py-1 font-mono text-sm uppercase dark:border-zinc-700 dark:bg-zinc-900"
          />
        </Field>
      )}

      {showAngle && (
        <Field label={`Angle (${angle}°)`}>
          <input
            type="range"
            min={0}
            max={360}
            value={angle}
            onChange={(e) => setAngle(Number(e.target.value))}
            className="w-full"
          />
        </Field>
      )}

      {showIntensity && (
        <Field label={`Intensity (${intensity.toFixed(2)}, capped at 0.70)`}>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={intensity}
            onChange={(e) => setIntensity(Number(e.target.value))}
            className="w-full"
          />
        </Field>
      )}

      {showSeed && (
        <Field label="Seed (optional)">
          <input
            type="number"
            value={seed}
            min={0}
            onChange={(e) => setSeed(e.target.value)}
            placeholder="auto"
            className="w-full rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
        </Field>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="w-full rounded bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
      >
        {submitting ? "Generating…" : "Generate"}
      </button>

      {error && (
        <p className="rounded border border-red-300 bg-red-50 p-2 text-xs text-red-900 dark:border-red-700 dark:bg-red-950/40 dark:text-red-200">
          {error}
        </p>
      )}
    </form>
  );
}

function BrandInputSelect({
  options,
  value,
  onChange,
  placeholder,
}: {
  options: BrandInputAsset[];
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded border border-zinc-300 bg-white px-2 py-1 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900"
    >
      <option value="">{placeholder}</option>
      {options.map((a) => (
        <option key={a.id} value={a.public_path}>
          {a.canonical_folder_type}/{a.original_filename}
          {a.device_type ? ` · ${a.device_type}` : ""}
          {a.screenshot_context ? ` · ${a.screenshot_context}` : ""}
        </option>
      ))}
    </select>
  );
}

function PlacementRulesSummary({ entry }: { entry: GeneratorRegistryEntry }) {
  const r = entry.default_placement_rules;
  return (
    <details className="rounded border border-zinc-200 bg-zinc-50 p-2 text-xs dark:border-zinc-800 dark:bg-zinc-900">
      <summary className="cursor-pointer font-medium text-zinc-700 dark:text-zinc-300">
        Placement defaults
      </summary>
      <ul className="mt-2 space-y-0.5 text-zinc-600 dark:text-zinc-400">
        <li>compatible roles: {r.compatible_roles.join(", ") || "—"}</li>
        <li>z_index: {r.recommended_z_index}</li>
        <li>safe area: {r.safe_area_required ? "required" : "no"}</li>
        <li>bleed allowed: {r.bleed_allowed ? "yes" : "no"}</li>
        {r.object_fit && <li>object_fit: {r.object_fit}</li>}
        {r.max_width_ratio !== undefined && <li>max width: {(r.max_width_ratio * 100).toFixed(0)}% of canvas</li>}
        {r.preferred_compositions && r.preferred_compositions.length > 0 && (
          <li>compositions: {r.preferred_compositions.join(", ")}</li>
        )}
      </ul>
    </details>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="block text-xs font-medium text-zinc-700 dark:text-zinc-300">{label}</span>
      {children}
    </label>
  );
}

// ── Recent gallery (Phase 4 — filters) ─────────────────────────────────────
function RecentGallery({
  assets,
  usage,
  onAssetDeleted,
  onAssetUpdated,
}: {
  assets: GeneratedAsset[];
  usage: Record<string, string[]>;
  onAssetDeleted: (id: string) => void;
  onAssetUpdated: (asset: GeneratedAsset) => void;
}) {
  // Filters: approved (only|only_unapproved|both), used (only|both), tag substring.
  const [approvedFilter, setApprovedFilter] = useState<"both" | "approved" | "unapproved">("both");
  const [usedFilter, setUsedFilter] = useState<"both" | "used" | "unused">("both");
  const [tagQuery, setTagQuery] = useState<string>("");

  const filtered = useMemo(() => {
    const q = tagQuery.trim().toLowerCase();
    return assets.filter((a) => {
      if (approvedFilter === "approved" && a.approved === false) return false;
      if (approvedFilter === "unapproved" && a.approved !== false) return false;
      const isUsed = (usage[a.id]?.length ?? 0) > 0;
      if (usedFilter === "used" && !isUsed) return false;
      if (usedFilter === "unused" && isUsed) return false;
      if (q.length > 0) {
        const hay = (a.tags ?? []).join(" ").toLowerCase() + " " + a.variant.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [assets, usage, approvedFilter, usedFilter, tagQuery]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2 rounded border border-zinc-200 bg-zinc-50 p-2 text-xs dark:border-zinc-800 dark:bg-zinc-900">
        <label className="space-y-0.5">
          <span className="block text-[10px] font-medium text-zinc-700 dark:text-zinc-300">Approval</span>
          <select
            value={approvedFilter}
            onChange={(e) => setApprovedFilter(e.target.value as "both" | "approved" | "unapproved")}
            className="rounded border border-zinc-300 bg-white px-1.5 py-0.5 text-xs dark:border-zinc-700 dark:bg-zinc-950"
          >
            <option value="both">all</option>
            <option value="approved">approved only</option>
            <option value="unapproved">unapproved only</option>
          </select>
        </label>
        <label className="space-y-0.5">
          <span className="block text-[10px] font-medium text-zinc-700 dark:text-zinc-300">Usage</span>
          <select
            value={usedFilter}
            onChange={(e) => setUsedFilter(e.target.value as "both" | "used" | "unused")}
            className="rounded border border-zinc-300 bg-white px-1.5 py-0.5 text-xs dark:border-zinc-700 dark:bg-zinc-950"
          >
            <option value="both">all</option>
            <option value="used">used in a campaign</option>
            <option value="unused">unused</option>
          </select>
        </label>
        <label className="grow space-y-0.5">
          <span className="block text-[10px] font-medium text-zinc-700 dark:text-zinc-300">
            Tag / variant filter
          </span>
          <input
            type="search"
            value={tagQuery}
            onChange={(e) => setTagQuery(e.target.value)}
            placeholder="e.g. accent_block, scrim, charts"
            className="w-full rounded border border-zinc-300 bg-white px-1.5 py-0.5 text-xs dark:border-zinc-700 dark:bg-zinc-950"
          />
        </label>
        <span className="ml-auto text-[10px] text-zinc-500">
          {filtered.length}/{assets.length}
        </span>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
          {assets.length === 0 ? "No assets yet — generate one above." : "No assets match the current filters."}
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((a) => (
            <AssetCard
              key={a.id}
              asset={a}
              usedIn={usage[a.id] ?? []}
              onDeleted={onAssetDeleted}
              onUpdated={onAssetUpdated}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function AssetCard({
  asset,
  usedIn,
  onDeleted,
  onUpdated,
}: {
  asset: GeneratedAsset;
  usedIn: string[];
  onDeleted: (id: string) => void;
  onUpdated: (asset: GeneratedAsset) => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isUsed = usedIn.length > 0;

  const handleDelete = async (force = false) => {
    if (!window.confirm(`Delete asset ${asset.id}?${force ? " (force, this asset is in use)" : ""}`)) return;
    setError(null);
    setDeleting(true);
    try {
      const url = `/api/generators/asset/${asset.id}${force ? "?force=1" : ""}`;
      const res = await fetch(url, { method: "DELETE" });
      const json = (await res.json()) as
        | { ok: true; deleted: GeneratedAsset }
        | { ok: false; error: string; message?: string; campaign_ids?: string[] };
      if (!json.ok) {
        if (json.error === "asset_in_use" && json.campaign_ids?.length) {
          // Surface the conflict; let the operator force-delete from a follow-up click.
          setError(
            `In use by ${json.campaign_ids.length} campaign(s): ${json.campaign_ids.join(", ")}. Click again to force-delete.`,
          );
        } else {
          setError("message" in json && json.message ? json.message : json.error);
        }
        setDeleting(false);
        return;
      }
      onDeleted(asset.id);
    } catch (err) {
      setError((err as Error).message);
      setDeleting(false);
    }
  };

  const handleToggleApproved = async () => {
    setError(null);
    setToggling(true);
    try {
      const res = await fetch(`/api/generators/asset/${asset.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approved: !asset.approved }),
      });
      const json = (await res.json()) as
        | { ok: true; asset: GeneratedAsset }
        | { ok: false; error: string; message?: string };
      if (!json.ok) {
        setError("message" in json && json.message ? json.message : json.error);
        setToggling(false);
        return;
      }
      onUpdated(json.asset);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setToggling(false);
    }
  };

  // Phase 4 — prefer the rendered thumbnail when present; otherwise fall back
  // to the full asset URL. Saves bandwidth on 4096×4096 backgrounds.
  const previewUrl = asset.preview_thumbnail_path ?? asset.url;

  return (
    <li className="overflow-hidden rounded border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={previewUrl}
        alt={asset.variant}
        className="block h-40 w-full object-contain bg-[conic-gradient(at_top_left,#eee_25%,#fafafa_25%_50%,#eee_50%_75%,#fafafa_75%)] bg-[length:16px_16px] dark:bg-zinc-900"
      />
      <div className="space-y-1 p-2 text-xs text-zinc-600 dark:text-zinc-400">
        <div className="flex items-center justify-between gap-2">
          <p className="truncate font-mono text-[10px] text-zinc-500">{asset.id}</p>
          <div className="flex shrink-0 items-center gap-1">
            <span
              className={
                asset.approved === false
                  ? "rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-900 dark:bg-amber-900/40 dark:text-amber-200"
                  : "rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-900 dark:bg-green-900/40 dark:text-green-200"
              }
            >
              {asset.approved === false ? "unapproved" : "approved"}
            </span>
            {isUsed && (
              <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-900 dark:bg-blue-900/40 dark:text-blue-200">
                used×{usedIn.length}
              </span>
            )}
          </div>
        </div>
        <p>
          <span className="font-medium text-zinc-900 dark:text-zinc-100">{asset.variant}</span>{" "}
          · {asset.size.width}×{asset.size.height} · {asset.format} · <em>{asset.render_mode}</em>
        </p>
        {asset.source_assets.length > 0 && (
          <p className="truncate text-[10px]">
            sources: {asset.source_assets.map((s) => s.id ?? s.public_path ?? s.path).join(", ")}
          </p>
        )}
        {asset.tags.length > 0 && (
          <p className="truncate text-[10px] text-zinc-500">tags: {asset.tags.join(", ")}</p>
        )}
        {isUsed && (
          <p className="truncate text-[10px] text-blue-700 dark:text-blue-300">
            campaigns: {usedIn.join(", ")}
          </p>
        )}
        {asset.element_manifest_preview && (
          <details className="rounded bg-zinc-50 px-1 py-0.5 text-[10px] dark:bg-zinc-900">
            <summary className="cursor-pointer text-zinc-700 dark:text-zinc-300">
              element_manifest_preview
            </summary>
            <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[10px]">
              {JSON.stringify(asset.element_manifest_preview, null, 2)}
            </pre>
          </details>
        )}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <a className="underline" href={asset.url} target="_blank" rel="noreferrer">
            Open file
          </a>
          <button
            type="button"
            onClick={handleToggleApproved}
            disabled={toggling}
            className="rounded border border-zinc-300 px-2 py-0.5 text-[10px] font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
          >
            {toggling ? "…" : asset.approved === false ? "Approve" : "Unapprove"}
          </button>
          <button
            type="button"
            onClick={() => handleDelete(error?.startsWith("In use by") ? true : false)}
            disabled={deleting}
            className="ml-auto rounded border border-red-300 px-2 py-0.5 text-[10px] font-medium text-red-700 hover:bg-red-50 disabled:opacity-60 dark:border-red-700 dark:text-red-300 dark:hover:bg-red-950/40"
          >
            {deleting
              ? "Deleting…"
              : error?.startsWith("In use by")
                ? "Force delete"
                : "Delete"}
          </button>
        </div>
        {error && (
          <p className="rounded border border-red-300 bg-red-50 p-1 text-[10px] text-red-900 dark:border-red-700 dark:bg-red-950/40 dark:text-red-200">
            {error}
          </p>
        )}
      </div>
    </li>
  );
}
