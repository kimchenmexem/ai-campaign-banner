import Link from "next/link";
import { promises as fs } from "node:fs";
import path from "node:path";
import { loadCampaignIndex } from "@/lib/ai/campaignPlanner";

// /campaigns
//
// Lists every saved campaign. Source of truth: data/campaigns/index.generated.json.
// Campaigns can come from the AI planner or from the Figma Adapter flow.

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
  const figmaFlags = await Promise.all(
    index.campaigns.map((c) =>
      fileExists(
        path.join(
          cwd,
          "data",
          "campaigns",
          c.campaign_id,
          "figma-adapter-campaign.generated.json",
        ),
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
      <div className="flex flex-wrap gap-2">
        <Link
          href="/campaign-planner"
          className="inline-flex items-center gap-2 rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          + Plan a new campaign
        </Link>
        <Link
          href="/figma-adapter"
          className="inline-flex items-center gap-2 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-900 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:hover:bg-zinc-900"
        >
          + Adapt Figma banner
        </Link>
      </div>

      {index.campaigns.length === 0 ? (
        <p className="text-sm text-zinc-500">
          No campaigns yet. Run{" "}
          <code className="font-mono">npm run campaign:generate-mock</code> or
          use <Link className="underline" href="/campaign-planner">/campaign-planner</Link> or{" "}
          <Link className="underline" href="/figma-adapter">/figma-adapter</Link>.
        </p>
      ) : (
        <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
          {index.campaigns.map((c, idx) => {
            const active = index.active_campaign_id === c.campaign_id;
            const figmaAdapter =
              c.source === "figma-adapter" ||
              c.campaign_id.startsWith("cam_figma_") ||
              figmaFlags[idx];
            const rendered = figmaAdapter ? true : renderedFlags[idx];
            return (
              <li key={c.campaign_id} className="flex items-center justify-between py-3 text-sm">
                <div className="space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/campaigns/${c.campaign_id}`}
                      className="font-medium hover:underline"
                    >
                      {c.campaign_name}
                    </Link>
                    {figmaAdapter && (
                      <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-medium text-blue-800 dark:bg-blue-950 dark:text-blue-200">
                        Figma Adapter
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-zinc-500">
                    <code className="font-mono">{c.campaign_id}</code> ·{" "}
                    {figmaAdapter ? (
                      <>
                        {c.concept_count} language{c.concept_count === 1 ? "" : "s"} ·{" "}
                        {c.ad_count} editable SVG{c.ad_count === 1 ? "" : "s"} · source{" "}
                        <code className="font-mono">figma-adapter</code>
                      </>
                    ) : (
                      <>
                        {c.concept_count} concept{c.concept_count === 1 ? "" : "s"} ·{" "}
                        {c.ad_count} ad{c.ad_count === 1 ? "" : "s"} · provider{" "}
                        <code className="font-mono">{c.ai_provider}</code>
                      </>
                    )}{" "}
                    ·{" "}
                    {new Date(c.created_at).toLocaleString()}
                  </div>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  {active && (
                    <span title="Active campaign" className="rounded-full bg-amber-200 px-2 py-0.5 font-medium text-amber-900 dark:bg-amber-900 dark:text-amber-100">
                      ★ active
                    </span>
                  )}
                  {rendered && !figmaAdapter && (
                    <span title="Code-rendered" className="rounded-full bg-emerald-200 px-2 py-0.5 font-medium text-emerald-900 dark:bg-emerald-900 dark:text-emerald-100">
                      ✓ rendered
                    </span>
                  )}
                  {figmaAdapter && (
                    <span title="Editable SVGs saved" className="rounded-full bg-emerald-200 px-2 py-0.5 font-medium text-emerald-900 dark:bg-emerald-900 dark:text-emerald-100">
                      ✓ SVGs
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
