import Link from "next/link";
import { promises as fs } from "node:fs";
import path from "node:path";
import { loadCampaignIndex } from "@/lib/ai/campaignPlanner";

// /campaigns
//
// Lists every saved CampaignPlan. Source of truth: data/campaigns/index.generated.json.
// The active marker (★) and rendered marker (✓) come from disk so the page
// never lies about what actually exists.

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

export default async function CampaignsPage() {
  const cwd = process.cwd();
  const index = await loadCampaignIndex(cwd);
  const renderedFlags = await Promise.all(
    index.campaigns.map((c) =>
      fileExists(
        path.join(cwd, "data", "campaigns", c.campaign_id, "code-render-map.generated.json"),
      ),
    ),
  );

  return (
    <section className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Campaigns</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          {index.campaigns.length} saved campaign
          {index.campaigns.length === 1 ? "" : "s"}.{" "}
          {index.active_campaign_id && (
            <>
              Active:{" "}
              <code className="font-mono">{index.active_campaign_id}</code>.
            </>
          )}
        </p>
      </header>
      <div>
        <Link
          href="/campaign-planner"
          className="inline-flex items-center gap-2 rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          + Plan a new campaign
        </Link>
      </div>

      {index.campaigns.length === 0 ? (
        <p className="text-sm text-zinc-500">
          No campaigns yet. Run{" "}
          <code className="font-mono">npm run campaign:generate-mock</code> or
          use <Link className="underline" href="/campaign-planner">/campaign-planner</Link>.
        </p>
      ) : (
        <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
          {index.campaigns.map((c, idx) => {
            const active = index.active_campaign_id === c.campaign_id;
            const rendered = renderedFlags[idx];
            return (
              <li key={c.campaign_id} className="flex items-center justify-between py-3 text-sm">
                <div className="space-y-0.5">
                  <Link
                    href={`/campaigns/${c.campaign_id}`}
                    className="font-medium hover:underline"
                  >
                    {c.campaign_name}
                  </Link>
                  <div className="text-xs text-zinc-500">
                    <code className="font-mono">{c.campaign_id}</code> ·{" "}
                    {c.concept_count} concept{c.concept_count === 1 ? "" : "s"} ·{" "}
                    {c.ad_count} ad{c.ad_count === 1 ? "" : "s"} ·{" "}
                    provider <code className="font-mono">{c.ai_provider}</code> ·{" "}
                    {new Date(c.created_at).toLocaleString()}
                  </div>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  {active && (
                    <span title="Active campaign" className="rounded-full bg-amber-200 px-2 py-0.5 font-medium text-amber-900 dark:bg-amber-900 dark:text-amber-100">
                      ★ active
                    </span>
                  )}
                  {rendered && (
                    <span title="Code-rendered" className="rounded-full bg-emerald-200 px-2 py-0.5 font-medium text-emerald-900 dark:bg-emerald-900 dark:text-emerald-100">
                      ✓ rendered
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
