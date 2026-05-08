import { promises as fs } from "node:fs";
import path from "node:path";
import {
  DemoCampaignSchema,
  type DemoCampaign,
} from "@/lib/preview/createDemoCampaign";
import {
  loadActiveCampaignPointer,
  loadCampaignIndex,
  loadCampaignPlanIfExists,
} from "@/lib/ai/campaignPlanner";
import { planToDemoView } from "@/lib/preview/planToDemoView";
import Link from "next/link";
import { VisualPreviewTabs } from "@/components/preview/VisualPreviewTabs";
import { CampaignPicker } from "@/components/preview/CampaignPicker";
import type { CampaignIndexFile } from "@/lib/schemas/aiCampaignPlan.schema";

// Local visual preview page.
//
// Source preference:
//   1. Active CampaignPlan (data/active-campaign.generated.json → data/campaigns/{id}/) —
//      adapted to a DemoCampaign-shaped view by planToDemoView so the existing
//      VisualPreviewTabs renderer needs no changes.
//   2. Fallback: data/demo-campaign.preview.json (the static demo).
//
// The Element Manifest is the source of truth in either path — this page only
// renders it. Bannerbear and Figma read the same manifests later.

export const dynamic = "force-dynamic";

const DEMO_PATH = path.join(process.cwd(), "data", "demo-campaign.preview.json");

interface PreviewSource {
  view: DemoCampaign;
  origin: "campaign" | "demo";
  campaign_id: string | null;
  // True when the operator asked for an explicit `?campaign=<id>` that
  // couldn't be loaded — surfaced as a warning banner so the picker fall-back
  // behaviour is obvious.
  requested_missing: boolean;
  picked_explicitly: boolean;
}

async function loadPreviewSource(
  requestedId: string | null,
): Promise<PreviewSource | null> {
  const cwd = process.cwd();
  const activeId = await loadActiveCampaignPointer(cwd);

  // Resolution order: ?campaign=<id> → active → static demo.
  const targetId = requestedId ?? activeId;
  let requestedMissing = false;
  if (targetId) {
    const plan = await loadCampaignPlanIfExists(targetId, cwd);
    if (plan) {
      return {
        view: planToDemoView(plan),
        origin: "campaign",
        campaign_id: plan.campaign_id,
        requested_missing: false,
        picked_explicitly: requestedId !== null,
      };
    }
    if (requestedId) requestedMissing = true;
  }

  try {
    const raw = await fs.readFile(DEMO_PATH, "utf8");
    return {
      view: DemoCampaignSchema.parse(JSON.parse(raw)),
      origin: "demo",
      campaign_id: null,
      requested_missing: requestedMissing,
      picked_explicitly: false,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function MissingDemoBanner() {
  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
      <p className="font-medium">No demo campaign found.</p>
      <p className="mt-1">
        Generate it with the commands below, then refresh this page.
      </p>
    </div>
  );
}

function HowToRun() {
  return (
    <div className="rounded-md border border-zinc-200 bg-zinc-50 p-4 text-sm dark:border-zinc-800 dark:bg-zinc-900">
      <p className="font-medium mb-2">Local visual preview pipeline</p>
      <ol className="list-decimal list-inside space-y-1 text-zinc-700 dark:text-zinc-300">
        <li>
          <code className="rounded bg-zinc-200 px-1 py-0.5 dark:bg-zinc-800">npm run brand:intake</code>
          <span className="ml-2 text-zinc-500">
            generates <code>data/brand-kit-lite.generated.json</code> and{" "}
            <code>data/asset-import-plan.generated.json</code>
          </span>
        </li>
        <li>
          <code className="rounded bg-zinc-200 px-1 py-0.5 dark:bg-zinc-800">npm run preview:assets</code>
          <span className="ml-2 text-zinc-500">
            copies brand-input/ into <code>public/brand-input-preview/</code> and writes{" "}
            <code>data/asset-preview-map.generated.json</code>
          </span>
        </li>
        <li>
          <code className="rounded bg-zinc-200 px-1 py-0.5 dark:bg-zinc-800">npm run preview:demo</code>
          <span className="ml-2 text-zinc-500">
            writes <code>data/demo-campaign.preview.json</code>
          </span>
        </li>
        <li>
          Refresh <code>/visual-preview</code>.
        </li>
      </ol>
      <p className="mt-3 text-xs text-zinc-500">
        Or run all three at once: <code>npm run preview:all</code>.
      </p>
    </div>
  );
}

export default async function VisualPreviewPage({
  searchParams,
}: {
  searchParams: Promise<{ campaign?: string }>;
}) {
  const params = await searchParams;
  const requestedId = params.campaign ?? null;
  const cwd = process.cwd();
  const [source, activeId, index]: [
    PreviewSource | null,
    string | null,
    CampaignIndexFile,
  ] = await Promise.all([
    loadPreviewSource(requestedId),
    loadActiveCampaignPointer(cwd),
    loadCampaignIndex(cwd),
  ]);

  return (
    <section className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Visual Preview</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400 max-w-2xl">
          Local preview only. Renders the active campaign&apos;s Element Manifests as
          positioned HTML/CSS so you can validate layout, copy, and asset selection
          before wiring Bannerbear or Cloudinary. The Element Manifest is the source
          of truth — Bannerbear and Figma will later read the same manifests.
        </p>
        <p className="text-xs">
          <Link
            href="/code-render-preview"
            className="text-sky-700 hover:underline dark:text-sky-400"
          >
            View Code Render Preview →
          </Link>
          <span className="mx-2 text-zinc-400">·</span>
          <Link
            href="/campaign-planner"
            className="text-sky-700 hover:underline dark:text-sky-400"
          >
            Plan a new campaign →
          </Link>
        </p>
      </header>

      <div className="rounded-md border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950">
        <CampaignPicker
          campaigns={index.campaigns}
          selectedId={source?.origin === "campaign" ? source.campaign_id : null}
          activeId={activeId}
          basePath="/visual-preview"
        />
      </div>

      {source?.requested_missing && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
          Campaign{" "}
          <code className="font-mono">{requestedId}</code> not found on disk —
          falling back to {source.origin === "campaign" ? "active campaign" : "the static demo"}.
        </div>
      )}

      {source && <SourceBanner source={source} activeId={activeId} />}
      <HowToRun />

      {source ? (
        <>
          {source.view.warnings.length > 0 && (
            <details className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
              <summary className="cursor-pointer font-medium select-none">
                Generation warnings ({source.view.warnings.length}) — click to expand
              </summary>
              <ul className="mt-2 list-disc list-inside">
                {source.view.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </details>
          )}
          <VisualPreviewTabs demo={source.view} />
        </>
      ) : (
        <MissingDemoBanner />
      )}
    </section>
  );
}

function SourceBanner({
  source,
  activeId,
}: {
  source: PreviewSource;
  activeId: string | null;
}) {
  if (source.origin === "campaign" && source.campaign_id) {
    const isActive = source.campaign_id === activeId;
    return (
      <div className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-200">
        <p>
          Showing campaign{" "}
          <Link href={`/campaigns/${source.campaign_id}`} className="font-mono underline">
            {source.campaign_id}
          </Link>
          {isActive ? (
            <span className="ml-1 rounded bg-emerald-200 px-1.5 py-0.5 text-[10px] font-medium dark:bg-emerald-900/50">active</span>
          ) : (
            <span className="ml-1 rounded bg-zinc-200 px-1.5 py-0.5 text-[10px] font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">picked</span>
          )}{" "}
          — {source.view.ad_specs.length} ad spec
          {source.view.ad_specs.length === 1 ? "" : "s"}.
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
      Showing the static demo (no active campaign). Generate one at{" "}
      <Link href="/campaign-planner" className="underline">
        /campaign-planner
      </Link>
      .
    </div>
  );
}
