import Link from "next/link";
import { promises as fs } from "node:fs";
import path from "node:path";
import { notFound } from "next/navigation";
import {
  loadCampaignPlanIfExists,
  loadActiveCampaignPointer,
} from "@/lib/ai/campaignPlanner";
import type { CampaignAdSpec, CampaignConcept } from "@/lib/schemas/aiCampaignPlan.schema";
import { CopyPromptButton } from "./CopyPromptButton";
import { RenderCampaignButton } from "./RenderCampaignButton";
import { RunQaButton } from "./RunQaButton";
import { loadCampaignVisionQa } from "@/lib/qa/runQaForCampaign";
import type { VisionQaMap } from "@/lib/qa/runQaForCampaign";

// /campaigns/[id]
//
// Detail view of a saved CampaignPlan. Reads the plan from disk; if a
// matching code-render map exists, surfaces rendered PNG paths. The
// Element Manifest is shown verbatim so operators can audit what code
// will render.

async function readJSONIfExists<T>(p: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(p, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

interface CodeRenderItem {
  ad_id: string;
  output_public_path: string | null;
  status: "completed" | "failed";
  bytes: number | null;
  format: string;
  concept_id: string | null;
}

interface CodeRenderMap {
  generated_at: string;
  items: CodeRenderItem[];
}

export default async function CampaignDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const cwd = process.cwd();
  const plan = await loadCampaignPlanIfExists(id, cwd);
  if (!plan) notFound();

  const activeId = await loadActiveCampaignPointer(cwd);
  const renderMap = await readJSONIfExists<CodeRenderMap>(
    path.join(cwd, "data", "campaigns", id, "code-render-map.generated.json"),
  );
  const renderByAd = new Map<string, CodeRenderItem>();
  for (const item of renderMap?.items ?? []) renderByAd.set(item.ad_id, item);
  // Phase: vision QA. Optional — null when QA hasn't been run yet for this
  // campaign. When present, the page surfaces a concept-level summary.
  const visionQa = await loadCampaignVisionQa(id, cwd);

  return (
    <section className="space-y-8">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{plan.campaign_name}</h1>
          {activeId === plan.campaign_id && (
            <span className="rounded-full bg-amber-200 px-2 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-900 dark:text-amber-100">
              ★ active
            </span>
          )}
        </div>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">{plan.campaign_summary}</p>
        <p className="text-xs text-zinc-500">
          <code className="font-mono">{plan.campaign_id}</code> ·{" "}
          provider <code className="font-mono">{plan.ai_provider}</code> ·{" "}
          {plan.concepts.length} concept{plan.concepts.length === 1 ? "" : "s"} ·{" "}
          {plan.concepts.reduce((acc, c) => acc + c.ad_specs.length, 0)} ad
          {plan.concepts.reduce((acc, c) => acc + c.ad_specs.length, 0) === 1 ? "" : "s"} ·{" "}
          created {new Date(plan.created_at).toLocaleString()}
        </p>
        <nav className="flex gap-3 text-xs">
          <Link className="underline" href="/campaigns">← All campaigns</Link>
          <Link className="underline" href="/visual-preview">Visual Preview</Link>
          <Link className="underline" href="/code-render-preview">Code Render</Link>
        </nav>
      </header>

      <div className="flex flex-wrap items-center gap-3 rounded-md border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950">
        <RenderCampaignButton
          campaignId={plan.campaign_id}
          alreadyRendered={renderMap !== null && renderMap.items.length > 0}
        />
        <a
          href={`/api/export-campaign-zip?campaign_id=${plan.campaign_id}`}
          download={`campaign-${plan.campaign_id}.zip`}
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-900 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:hover:bg-zinc-900"
        >
          Download ZIP ↓
        </a>
        <a
          // SVG-only ZIP. No render dependency — works directly from the
          // campaign plan. Remote Cloudinary refs by default to keep the
          // archive small + safely under Vercel's response-size cap even
          // for campaigns that reference large product mockups.
          href={`/api/export-campaign-svgs?campaign_id=${plan.campaign_id}`}
          download={`campaign-${plan.campaign_id}-svgs.zip`}
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-900 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:hover:bg-zinc-900"
          title="All banners as SVG, bundled in a ZIP. Drag any file into Figma. Works even before rendering."
        >
          ↓ All SVGs (Figma)
        </a>
        <p className="text-xs text-zinc-600 dark:text-zinc-400">
          {renderMap === null
            ? "PNGs not generated yet. Click to render this campaign as flat banners (~30s for 9 ads). The ZIP will auto-render if missing."
            : `Last render: ${new Date(renderMap.generated_at).toLocaleString()} · ${renderMap.items.length} ads.`}
        </p>
      </div>

      <BriefBlock brief={plan.source_brief} />
      {plan.warnings.length > 0 && (
        <WarningsBlock warnings={plan.warnings} />
      )}

      <VisionQaBlock
        campaignId={plan.campaign_id}
        qa={visionQa}
        canRun={renderMap !== null && renderMap.items.some((i) => i.status === "completed")}
      />

      <div className="space-y-10">
        {plan.concepts.map((concept) => (
          <ConceptBlock
            key={concept.concept_id}
            concept={concept}
            renderByAd={renderByAd}
          />
        ))}
      </div>
    </section>
  );
}

function BriefBlock({ brief }: { brief: import("@/lib/schemas/campaignBrief.schema").CampaignBrief }) {
  return (
    <details className="rounded-lg border border-zinc-200 bg-white p-4 text-sm dark:border-zinc-800 dark:bg-zinc-950">
      <summary className="cursor-pointer font-medium">Source brief</summary>
      <dl className="mt-3 grid gap-3 sm:grid-cols-2">
        <Row k="brief_id" v={<code className="font-mono">{brief.brief_id}</code>} />
        <Row k="brand_id" v={<code className="font-mono">{brief.brand_id}</code>} />
        <Row k="goal" v={brief.campaign_goal} />
        <Row k="tone" v={brief.tone.join(", ")} />
        <Row
          k="platforms"
          v={
            !brief.platforms || brief.platforms.length === 0
              ? "—"
              : brief.platforms.join(", ")
          }
        />
        <Row k="formats" v={brief.required_formats.join(", ")} />
        <Row k="risk warning" v={brief.risk_warning_required ? "required" : "off"} />
      </dl>
      <div className="mt-3 space-y-2">
        <Block label="marketing_message">{brief.marketing_message}</Block>
        {brief.target_audience && (
          <Block label="target_audience">{brief.target_audience}</Block>
        )}
        {brief.notes && <Block label="notes">{brief.notes}</Block>}
      </div>
    </details>
  );
}

function WarningsBlock({ warnings }: { warnings: string[] }) {
  // Collapsed by default — long warning lists were dominating the campaign
  // page above the actual concepts. Operators can still see the count
  // (which doubles as the toggle) and expand on demand. Native <details>
  // keeps this server-component-friendly (no useState).
  return (
    <details className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
      <summary className="cursor-pointer font-medium select-none">
        Warnings ({warnings.length}) — click to expand
      </summary>
      <ul className="ml-4 mt-2 list-disc">
        {warnings.map((w, i) => (
          <li key={i}>{w}</li>
        ))}
      </ul>
    </details>
  );
}

// Phase: vision QA — concept-level summary block. No per-banner score; just
// "X violations across N banners" per concept, plus a button to (re)run.
// Detailed per-banner violation list lives in
// data/campaigns/<id>/vision-qa.generated.json.
function VisionQaBlock({
  campaignId,
  qa,
  canRun,
}: {
  campaignId: string;
  qa: VisionQaMap | null;
  canRun: boolean;
}) {
  // Collapsed by default — the violations list is verbose and was crowding
  // the campaign page above the actual concepts. The summary line still
  // surfaces the headline status (no violations / N flagged / not yet run)
  // so the operator can decide whether to expand without clicking.
  if (!canRun && !qa) {
    return (
      <details className="rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
        <summary className="cursor-pointer font-medium select-none text-zinc-700 dark:text-zinc-300">
          Vision QA — not yet run · click to expand
        </summary>
        <p className="mt-2">
          Render the campaign first — Vision QA reads the rendered PNGs and
          checks them against <code>docs/BANNER_REFERENCE_RULES.md</code>.
        </p>
      </details>
    );
  }
  const statusLabel = qa
    ? qa.with_violations === 0
      ? "no violations"
      : `${qa.with_violations}/${qa.total} banners flagged`
    : "not yet run";
  return (
    <details className="space-y-2 rounded-md border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950">
      <summary className="cursor-pointer font-medium select-none">
        Vision QA — {statusLabel} · click to expand
      </summary>
      <div className="mt-2 space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <RunQaButton
            campaignId={campaignId}
            alreadyRan={qa !== null}
            canRun={canRun}
          />
          {qa && (
            <span className="text-xs text-zinc-500">
              last run: {new Date(qa.generated_at).toLocaleString()} ·{" "}
              {qa.with_violations === 0 ? (
                <span className="font-medium text-emerald-700 dark:text-emerald-400">no violations</span>
              ) : (
                <span className="font-medium text-amber-700 dark:text-amber-300">
                  {qa.with_violations}/{qa.total} banners flagged
                </span>
              )}
            </span>
          )}
        </div>
        {qa && qa.with_violations > 0 && (
          <ul className="space-y-2 text-sm">
            {qa.concept_summary
              .filter((c) => c.violation_count > 0)
              .map((c) => {
                const banners = qa.banners.filter(
                  (b) =>
                    qa.banners.find(
                      (x) => x.ad_id === b.ad_id,
                    ) &&
                    b.violations.length > 0,
                );
                const violationsForConcept = banners.filter((b) =>
                  b.ad_id.includes(c.concept_id),
                );
                return (
                  <li
                    key={c.concept_id}
                    className="rounded border border-amber-300 bg-amber-50 p-2 dark:border-amber-700 dark:bg-amber-950/40"
                  >
                    <p className="text-xs font-medium text-amber-900 dark:text-amber-200">
                      <code className="font-mono">{c.concept_id}</code> —{" "}
                      {c.violation_count} violation{c.violation_count === 1 ? "" : "s"}{" "}
                      across {c.banners_with_violations}/{c.total_banners} banner
                      {c.total_banners === 1 ? "" : "s"}{" "}
                      <span className="opacity-75">
                        (block={c.severities.block} warn={c.severities.warn} info={c.severities.info})
                      </span>
                    </p>
                    <ul className="mt-1 space-y-0.5 text-xs text-amber-900 dark:text-amber-100">
                      {violationsForConcept.flatMap((b) =>
                        b.violations.map((v, i) => (
                          <li key={`${b.ad_id}-${i}`} className="font-mono">
                            [{v.severity}] {b.format} · {v.rule_id} — {v.description}
                          </li>
                        )),
                      )}
                    </ul>
                  </li>
                );
              })}
          </ul>
        )}
        {qa && qa.with_violations === 0 && (
          <p className="text-xs text-emerald-700 dark:text-emerald-400">
            Vision QA found no brand-rule violations across the campaign.
          </p>
        )}
      </div>
    </details>
  );
}

function ConceptBlock({
  concept,
  renderByAd,
}: {
  concept: CampaignConcept;
  renderByAd: Map<string, CodeRenderItem>;
}) {
  return (
    <article className="space-y-4 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
      <header className="space-y-1">
        <h2 className="text-lg font-semibold">{concept.name}</h2>
        <p className="text-xs text-zinc-500">
          <code className="font-mono">{concept.concept_id}</code> · target emotion:{" "}
          <em>{concept.target_emotion}</em> · tone: <em>{concept.tone}</em> · context:{" "}
          <code className="font-mono">{concept.desired_visual_context}</code>
        </p>
      </header>
      <p className="text-sm text-zinc-700 dark:text-zinc-300">
        <span className="font-medium">Strategic idea:</span> {concept.strategic_idea}
      </p>

      <section className="grid gap-3 sm:grid-cols-2">
        <Block label="headline">{concept.copy_package.headline}</Block>
        <Block label="cta">{concept.copy_package.cta}</Block>
        <Block label="subheadline">{concept.copy_package.subheadline}</Block>
        <Block label="disclaimer">{concept.copy_package.disclaimer}</Block>
      </section>

      <details className="rounded-md border border-zinc-200 p-3 text-xs dark:border-zinc-800">
        <summary className="cursor-pointer font-medium">Visual direction</summary>
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs text-zinc-700 dark:text-zinc-300">
          {JSON.stringify(concept.visual_direction, null, 2)}
        </pre>
      </details>

      {concept.midjourney_prompt_pack.length > 0 && (
        <details className="rounded-md border border-zinc-200 p-3 text-xs dark:border-zinc-800" open>
          <summary className="cursor-pointer font-medium">
            Midjourney prompt pack ({concept.midjourney_prompt_pack.length})
          </summary>
          <p className="mt-1 text-[11px] text-zinc-500">
            Copy each prompt, run it on Midjourney, then upload the result on{" "}
            <Link className="underline" href="/midjourney">/midjourney</Link>.
            An approved upload whose <code className="font-mono">context</code> matches
            this concept&apos;s{" "}
            <code className="font-mono">{concept.desired_visual_context}</code>{" "}
            will be picked up automatically as this concept&apos;s background
            on the next campaign generation.
          </p>
          <ul className="mt-2 space-y-2">
            {concept.midjourney_prompt_pack.map((p) => (
              <li key={p.prompt_id} className="rounded border border-zinc-200 p-2 dark:border-zinc-800">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-zinc-500">
                    <code className="font-mono">{p.prompt_id}</code> ·{" "}
                    {p.intended_use} · {p.aspect_ratio} · {p.context}
                  </div>
                  <div className="flex items-center gap-1">
                    <CopyPromptButton text={p.prompt_text} />
                    <a
                      href="https://www.midjourney.com/imagine"
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-md border border-zinc-300 px-2 py-1 text-[11px] hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                    >
                      Open Midjourney ↗
                    </a>
                  </div>
                </div>
                <pre className="mt-1 whitespace-pre-wrap font-mono text-xs">{p.prompt_text}</pre>
                {p.notes && <p className="mt-1 text-zinc-500">{p.notes}</p>}
              </li>
            ))}
          </ul>
        </details>
      )}

      <section className="space-y-3">
        <h3 className="text-sm font-medium">Ad specs ({concept.ad_specs.length})</h3>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {concept.ad_specs.map((ad) => (
            <AdSpecCard
              key={ad.ad_id}
              ad={ad}
              render={renderByAd.get(ad.ad_id) ?? null}
              campaignId={concept.campaign_id}
            />
          ))}
        </div>
      </section>
    </article>
  );
}

function AdSpecCard({
  ad,
  render,
  campaignId,
}: {
  ad: CampaignAdSpec;
  render: CodeRenderItem | null;
  campaignId: string;
}) {
  const downloadHref = `/api/export-ad-elements?campaign_id=${encodeURIComponent(campaignId)}&ad_id=${encodeURIComponent(ad.ad_id)}`;
  const svgHref = `/api/export-ad-svg?campaign_id=${encodeURIComponent(campaignId)}&ad_id=${encodeURIComponent(ad.ad_id)}`;
  return (
    <div className="space-y-2 rounded-md border border-zinc-200 p-3 text-xs dark:border-zinc-800">
      <div className="flex items-center justify-between">
        <span className="font-medium">{ad.format}</span>
        <span className="text-zinc-500">{ad.channel}</span>
      </div>
      {render?.output_public_path ? (
        // Local file under /public; using <img> deliberately because Next/Image
        // would compress and we want the actual rendered banner displayed as-is.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={render.output_public_path}
          alt={ad.ad_id}
          className="h-auto w-full rounded border border-zinc-200 dark:border-zinc-800"
        />
      ) : (
        <div className="flex aspect-[1.91/1] items-center justify-center rounded border border-dashed border-zinc-300 text-zinc-400 dark:border-zinc-700">
          not yet rendered
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <a
          href={downloadHref}
          // <a download> hits the API route which sets Content-Disposition: attachment.
          download
          className="rounded border border-zinc-300 px-2 py-1 text-[11px] font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
          title="ZIP with rendered PNG, manifest, and one file per element"
        >
          ↓ Download elements
        </a>
        <a
          href={svgHref}
          download
          className="rounded border border-zinc-300 px-2 py-1 text-[11px] font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
          title="Single SVG of the full banner. Drag into Figma — text stays editable, images embedded as data URIs."
        >
          ↓ SVG (Figma)
        </a>
        {render?.output_public_path && (
          <a
            href={render.output_public_path}
            download
            className="rounded border border-zinc-300 px-2 py-1 text-[11px] font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
          >
            ↓ PNG only
          </a>
        )}
      </div>
      <div className="text-zinc-500">
        <code className="font-mono">{ad.ad_id}</code>
      </div>
      <div className="text-zinc-500">
        {ad.canvas_width}×{ad.canvas_height} · status: {ad.status}
      </div>
      <div className="text-zinc-500">
        intended_device:{" "}
        <code className="font-mono">{ad.visual_selection_metadata.intended_device_type}</code> ·{" "}
        context:{" "}
        <code className="font-mono">{ad.visual_selection_metadata.selected_context}</code>
        {ad.visual_selection_metadata.fallback_used && (
          <>
            {" "}· <span className="text-amber-700 dark:text-amber-400">fallback: {ad.visual_selection_metadata.fallback_kind}</span>
          </>
        )}
      </div>
      <details className="text-zinc-600 dark:text-zinc-400">
        <summary className="cursor-pointer">Element manifest ({ad.manifest.elements.length})</summary>
        <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap font-mono text-[10px]">
          {JSON.stringify(ad.manifest, null, 2)}
        </pre>
      </details>
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="w-28 shrink-0 text-zinc-500">{k}</dt>
      <dd className="flex-1">{v}</dd>
    </div>
  );
}

function Block({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded border border-zinc-200 p-2 text-xs dark:border-zinc-800">
      <div className="text-zinc-500">{label}</div>
      <div className="mt-1 text-sm text-zinc-900 dark:text-zinc-100">{children}</div>
    </div>
  );
}
