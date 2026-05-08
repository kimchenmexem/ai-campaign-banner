"use client";
import { useMemo, useState } from "react";
import { AdPreviewCanvas } from "@/components/preview/AdPreviewCanvas";
import { ManifestViewer } from "@/components/preview/ManifestViewer";
import type { DemoCampaign } from "@/lib/preview/createDemoCampaign";

// Asset role badge classes — keep small + readable.
const ROLE_BADGE: Record<string, string> = {
  brand_logo: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200",
  powered_by_ib: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200",
  background: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  mockup: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  platform_screenshot:
    "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200",
  decorative: "bg-zinc-100 text-zinc-800 dark:bg-zinc-900 dark:text-zinc-300",
};

function Badge({ kind, value }: { kind: string; value: string | null }) {
  const cls = ROLE_BADGE[kind] ?? ROLE_BADGE.decorative;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${cls}`}>
      <span className="font-medium">{kind}</span>
      <span className="opacity-70 truncate max-w-[24ch]">{value ?? "—"}</span>
    </span>
  );
}

const CONFIDENCE_TONE: Record<string, string> = {
  explicit_tag: "text-emerald-700 dark:text-emerald-400",
  filename_match: "text-sky-700 dark:text-sky-400",
  folder_match: "text-sky-700 dark:text-sky-400",
  fallback_general: "text-amber-700 dark:text-amber-400",
};

function ConfidenceBadge({ value }: { value: string | null }) {
  if (!value) return <span className="text-zinc-500">—</span>;
  return <span className={CONFIDENCE_TONE[value] ?? "text-zinc-700"}>{value}</span>;
}

function MidjourneyUsage({ demo }: { demo: DemoCampaign }) {
  const mj = demo.asset_selection.midjourney;
  // Walk the manifests so we can surface per-spec assignment_id +
  // target_element_role (the assignment-driven slot, not just the global
  // default IDs).
  const perSpecElements = demo.ad_specs.flatMap((s) =>
    s.manifest.elements
      .filter((el) => el.source === "midjourney_manual_upload")
      .map((el) => ({
        spec_id: s.specId,
        format: `${s.size.width}x${s.size.height}`,
        element_id: el.id,
        role: el.role,
        upload_id: el.midjourney?.upload_id ?? null,
        prompt_id: el.midjourney?.prompt_id ?? null,
        intended_use: el.midjourney?.intended_use ?? null,
        context: el.midjourney?.context ?? null,
        approved: el.midjourney?.approved ?? null,
        assignment_id: el.midjourney?.assignment_id ?? null,
        target_element_role: el.midjourney?.target_element_role ?? null,
      })),
  );

  const hasAny =
    mj.background_upload_id ||
    mj.decorative_upload_ids.length > 0 ||
    mj.hero_upload_id ||
    perSpecElements.length > 0;
  if (!hasAny) return null;
  return (
    <div className="rounded-md border border-violet-300 bg-violet-50 p-3 text-xs text-violet-900 dark:border-violet-800 dark:bg-violet-950 dark:text-violet-100">
      <div className="font-medium">Midjourney usage</div>
      {perSpecElements.length > 0 && (
        <table className="mt-2 w-full text-[11px]">
          <thead className="text-violet-800 dark:text-violet-300">
            <tr>
              <th className="pr-2 text-left">format</th>
              <th className="pr-2 text-left">role</th>
              <th className="pr-2 text-left">upload</th>
              <th className="pr-2 text-left">target</th>
              <th className="pr-2 text-left">assignment</th>
              <th className="pr-2 text-left">approved</th>
            </tr>
          </thead>
          <tbody>
            {perSpecElements.map((e, i) => (
              <tr key={`${e.spec_id}-${e.element_id}-${i}`}>
                <td className="pr-2">{e.format}</td>
                <td className="pr-2">{e.role}</td>
                <td className="pr-2">
                  <code>{e.upload_id?.slice(0, 12) ?? "—"}</code>
                </td>
                <td className="pr-2">{e.target_element_role ?? "—"}</td>
                <td className="pr-2">
                  {e.assignment_id ? (
                    <code className="text-emerald-700 dark:text-emerald-400">
                      {e.assignment_id.slice(0, 12)}
                    </code>
                  ) : (
                    <span className="text-amber-700 dark:text-amber-400">default</span>
                  )}
                </td>
                <td className="pr-2">{e.approved ? "yes" : "no"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="mt-2 text-[11px]">
        Every row above carries{" "}
        <code>provenance.generated_by = &quot;midjourney&quot;</code>,{" "}
        <code>uploaded_by_user = true</code>,{" "}
        <code>manual_workflow = true</code> on the manifest element.
      </p>
    </div>
  );
}

function SlotSourceBadge({ value }: { value: string | null }) {
  if (!value) return <span className="text-zinc-500">—</span>;
  if (value === "explicit_manifest")
    return (
      <span className="text-emerald-700 dark:text-emerald-400">explicit_manifest</span>
    );
  return <span className="text-amber-700 dark:text-amber-400">{value}</span>;
}

// Pull the product-visual element's delivery_source. If every visual on this
// ad uses Cloudinary, show "cloudinary"; if every visual uses local, show
// "local_preview"; if mixed, show both.
function DeliverySourceBadge({
  elements,
}: {
  elements: { delivery_source?: string; file_url?: string }[];
}) {
  const sources = new Set<string>();
  for (const el of elements) {
    if (el.delivery_source) sources.add(el.delivery_source);
  }
  if (sources.size === 0) return <span className="text-zinc-500">—</span>;
  const labels = Array.from(sources).sort();
  const tone = labels.every((l) => l === "cloudinary")
    ? "text-emerald-700 dark:text-emerald-400"
    : labels.every((l) => l === "local_preview")
      ? "text-amber-700 dark:text-amber-400"
      : "text-sky-700 dark:text-sky-400";
  return <span className={tone}>{labels.join(" + ")}</span>;
}

export function VisualPreviewTabs({ demo }: { demo: DemoCampaign }) {
  // Key tabs by specId — when the demo is a CampaignPlan projection it
  // contains 3 concepts × 3 sizes, so the same size string repeats and
  // would collide as a React key. specId is unique per ad.
  const [active, setActive] = useState<string>(demo.ad_specs[0]?.specId ?? "");

  // Build a per-spec gradient lookup for any background element that uses CSS.
  const gradientCssBySpec = useMemo(() => {
    const map: Record<string, Record<string, string>> = {};
    const fill = demo.asset_selection.background_fill;
    if (fill.kind === "gradient") {
      for (const s of demo.ad_specs) {
        map[s.specId] = { el_background: fill.css };
      }
    }
    return map;
  }, [demo]);

  const activeSpec = demo.ad_specs.find((s) => s.specId === active);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2">
        {demo.ad_specs.map((s) => {
          const sizeKey = `${s.size.width}x${s.size.height}`;
          const isActive = s.specId === active;
          return (
            <button
              key={s.specId}
              type="button"
              onClick={() => setActive(s.specId)}
              title={s.copy.headline}
              className={`rounded-md px-3 py-1.5 text-sm ring-1 text-left ${
                isActive
                  ? "ring-zinc-900 bg-zinc-900 text-white dark:ring-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                  : "ring-zinc-300 hover:ring-zinc-500 dark:ring-zinc-700 dark:hover:ring-zinc-500"
              }`}
            >
              <span className="block">{sizeKey} <span className="opacity-70">· {s.channel}</span></span>
              <span className="block text-[10px] opacity-70 truncate max-w-[20ch]">
                {s.copy.headline}
              </span>
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap gap-2 text-xs">
        <Badge kind="brand_logo" value={demo.asset_selection.brand_logo} />
        <Badge kind="powered_by_ib" value={demo.asset_selection.powered_by_ib} />
        <Badge kind="background" value={demo.asset_selection.background} />
        <Badge kind="mockup" value={demo.asset_selection.mockup} />
        <Badge kind="platform_screenshot" value={demo.asset_selection.platform_screenshot} />
      </div>

      <MidjourneyUsage demo={demo} />


      {activeSpec && (
        <div className="grid gap-6 lg:grid-cols-[1fr_minmax(0,420px)]">
          <div className="space-y-3">
            <AdPreviewCanvas
              manifest={activeSpec.manifest}
              maxWidth={760}
              gradientCssById={gradientCssBySpec[activeSpec.specId]}
            />

            {/* Composite info panel — per-spec traceability */}
            <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3 text-xs dark:border-zinc-800 dark:bg-zinc-900">
              <div className="mb-1.5 font-medium text-zinc-900 dark:text-zinc-100">
                Visual selection
              </div>
              <dl className="grid grid-cols-[12rem_1fr] gap-x-3 gap-y-1 text-zinc-700 dark:text-zinc-300">
                <dt className="text-zinc-500">Desired context</dt>
                <dd>{activeSpec.composite_metadata.desired_context}</dd>
                <dt className="text-zinc-500">Selected context</dt>
                <dd>{activeSpec.composite_metadata.selected_context}</dd>
                <dt className="text-zinc-500">Intended device</dt>
                <dd>{activeSpec.composite_metadata.intended_device_type}</dd>
                <dt className="text-zinc-500">Mockup</dt>
                <dd>{activeSpec.composite_metadata.mockup_filename ?? "—"}</dd>
                <dt className="text-zinc-500">Screenshot</dt>
                <dd>{activeSpec.composite_metadata.screenshot_filename ?? "—"}</dd>
                <dt className="text-zinc-500">Context confidence</dt>
                <dd>
                  <ConfidenceBadge value={activeSpec.composite_metadata.screenshot_context_confidence} />
                </dd>
                <dt className="text-zinc-500">Screen slot source</dt>
                <dd>
                  <SlotSourceBadge value={activeSpec.composite_metadata.mockup_slot_source} />
                </dd>
                <dt className="text-zinc-500">Fallback used</dt>
                <dd>
                  {activeSpec.composite_metadata.fallback_used ? (
                    <span className="text-amber-700 dark:text-amber-400">yes</span>
                  ) : (
                    <span className="text-emerald-700 dark:text-emerald-400">no</span>
                  )}
                </dd>
                <dt className="text-zinc-500">Composite</dt>
                <dd>
                  {activeSpec.composite_metadata.fallback_kind === "composite" ? (
                    <span className="text-emerald-700 dark:text-emerald-400">
                      ✓ generated · {activeSpec.composite_metadata.composite_id}
                    </span>
                  ) : (
                    <span className="text-amber-700 dark:text-amber-400">
                      not generated · fallback: {activeSpec.composite_metadata.fallback_kind}
                    </span>
                  )}
                </dd>
                <dt className="text-zinc-500">Composite path</dt>
                <dd className="truncate">
                  {activeSpec.composite_metadata.composite_public_path ? (
                    <a
                      href={activeSpec.composite_metadata.composite_public_path}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sky-700 hover:underline dark:text-sky-400"
                    >
                      {activeSpec.composite_metadata.composite_public_path}
                    </a>
                  ) : (
                    <span className="text-zinc-500">—</span>
                  )}
                </dd>
                <dt className="text-zinc-500">Delivery source</dt>
                <dd>
                  <DeliverySourceBadge
                    elements={activeSpec.manifest.elements}
                  />
                </dd>
              </dl>
              {activeSpec.composite_metadata.notes && (
                <p className="mt-2 text-[11px] italic text-zinc-500">
                  {activeSpec.composite_metadata.notes}
                </p>
              )}
            </div>

            <div className="text-xs text-zinc-500 dark:text-zinc-400">
              Headline: <em>{activeSpec.copy.headline}</em>
              <br />
              Subheadline: <em>{activeSpec.copy.subheadline}</em>
              <br />
              CTA: <em>{activeSpec.copy.cta}</em>
              <br />
              Disclaimer: <em>{activeSpec.copy.disclaimer || "(none)"}</em>
            </div>
          </div>
          <div>
            <ManifestViewer manifest={activeSpec.manifest} initiallyOpen={false} />
          </div>
        </div>
      )}
    </div>
  );
}
