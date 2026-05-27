import Link from "next/link";
import { promises as fs } from "node:fs";
import path from "node:path";
import { CampaignPlannerForm } from "./CampaignPlannerForm";
import { loadCampaignDefaults } from "@/lib/settings/campaignDefaultsStore";

// /campaign-planner
//
// Operator-facing form for the AI Campaign Planner. The form is a Client
// Component (CampaignPlannerForm); this server component just renders the
// outer chrome and probes which AI provider the env is configured for so the
// UI can show it as the default.
//
// Submitting POSTs to /api/generate-campaign, which validates the brief,
// calls the AI provider, validates AI output, builds ad_specs deterministically
// (Element Manifest stays the source of truth), and saves to
// data/campaigns/{id}/. On success the form redirects to /campaigns/{id}.

async function readBrandId(cwd: string = process.cwd()): Promise<string | null> {
  try {
    const raw = await fs.readFile(
      path.join(cwd, "data", "brand-kit-lite.generated.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as { brand_id?: string };
    return typeof parsed.brand_id === "string" ? parsed.brand_id : null;
  } catch {
    return null;
  }
}

function readDefaultProvider(): "mock" | "openai" | "anthropic" {
  const v = (process.env.AI_PROVIDER ?? "").toLowerCase();
  return v === "openai" || v === "anthropic" ? v : "mock";
}

export default async function CampaignPlannerPage() {
  const brandId = await readBrandId();
  const defaultProvider = readDefaultProvider();
  const campaignDefaults = await loadCampaignDefaults();

  return (
    <section className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Campaign Planner</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Brief the AI. The system generates concepts and builds ad specs. Element
          Manifest stays the source of truth — the AI never decides layout.
        </p>
      </header>

      {brandId === null ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
          <p className="font-medium">No brand kit found.</p>
          <p>
            Run <code className="font-mono">npm run brand:intake</code> first so
            the planner has a brand to work with.
          </p>
        </div>
      ) : (
        <>
          <div className="rounded-md border border-zinc-200 bg-white p-3 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
            <span className="font-medium text-zinc-900 dark:text-zinc-100">brand_id:</span>{" "}
            <code className="font-mono">{brandId}</code> ·{" "}
            <span className="font-medium text-zinc-900 dark:text-zinc-100">default provider:</span>{" "}
            <code className="font-mono">{defaultProvider}</code>
          </div>
          <CampaignPlannerForm
            brandId={brandId}
            defaultProvider={defaultProvider}
            initialDefaults={campaignDefaults.campaign_planner}
          />
        </>
      )}

      <p className="text-xs text-zinc-500">
        See <Link className="underline" href="/campaigns">/campaigns</Link> for
        previously generated plans.
      </p>
    </section>
  );
}
