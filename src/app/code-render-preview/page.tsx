import { promises as fs } from "node:fs";
import path from "node:path";
import Link from "next/link";
import { z } from "zod";
import {
  DemoCampaignSchema,
  type DemoCampaign,
  type DemoAdSpec,
} from "@/lib/preview/createDemoCampaign";
import {
  loadActiveCampaignPointer,
  loadCampaignIndex,
  loadCampaignPlanIfExists,
} from "@/lib/ai/campaignPlanner";
import { planToDemoView } from "@/lib/preview/planToDemoView";
import { AdPreviewCanvas } from "@/components/preview/AdPreviewCanvas";
import { CampaignPicker } from "@/components/preview/CampaignPicker";

// /code-render-preview
//
// Side-by-side: local HTML/CSS preview vs the code-rendered final PNG that
// the headless Chromium screenshot captured. Bannerbear is intentionally
// optional — this page works whether or not Bannerbear renders exist.
//
// Source preference:
//   1. Active CampaignPlan (data/active-campaign.generated.json), with renders
//      from data/campaigns/{id}/code-render-map.generated.json.
//   2. Fallback: static demo + data/code-render-map.generated.json.

export const dynamic = "force-dynamic";

const DEMO_PATH = path.join(process.cwd(), "data", "demo-campaign.preview.json");
const CODE_MAP_PATH = path.join(
  process.cwd(),
  "data",
  "code-render-map.generated.json",
);
const CLOUDINARY_CODE_MAP_PATH = path.join(
  process.cwd(),
  "data",
  "cloudinary-code-render-map.generated.json",
);

const CodeRenderRecordSchema = z.object({
  ad_id: z.string(),
  format: z.string(),
  canvas_width: z.number().int().positive(),
  canvas_height: z.number().int().positive(),
  output_local_path: z.string().nullable(),
  output_public_path: z.string().nullable(),
  status: z.enum(["completed", "failed"]),
  rendered_at: z.string(),
  source: z.literal("code_renderer"),
  element_manifest_hash: z.string().nullable(),
  bytes: z.number().int().nonnegative().nullable(),
  warnings: z.array(z.string()),
  error: z.string().optional(),
});
type CodeRenderRecord = z.infer<typeof CodeRenderRecordSchema>;

const CodeRenderMapSchema = z.object({
  generated_at: z.string(),
  // The campaign-mode map omits brand_id; demo-mode map keeps it.
  brand_id: z.string().optional(),
  campaign_id: z.string().nullable().optional(),
  base_url: z.string(),
  total: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  items: z.array(CodeRenderRecordSchema),
});
type CodeRenderMap = z.infer<typeof CodeRenderMapSchema>;

const CloudinaryCodeRenderRecordSchema = z.object({
  ad_id: z.string(),
  format: z.string(),
  local_output_path: z.string(),
  cloudinary_public_id: z.string().nullable(),
  cloudinary_secure_url: z.string().nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  format_extension: z.string().nullable(),
  bytes: z.number().int().nonnegative().nullable(),
  uploaded_at: z.string().nullable(),
  upload_status: z.enum(["success", "skipped", "failed"]),
  upload_error: z.string().optional(),
});
const CloudinaryCodeRenderMapSchema = z.object({
  generated_at: z.string(),
  brand_id: z.string(),
  cloud_name: z.string().nullable(),
  folder: z.string(),
  items: z.array(CloudinaryCodeRenderRecordSchema),
});
type CloudinaryCodeRenderMap = z.infer<typeof CloudinaryCodeRenderMapSchema>;

async function loadJsonOrNull<T>(filePath: string, schema: z.ZodType<T>): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return schema.parse(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export default async function CodeRenderPreviewPage({
  searchParams,
}: {
  searchParams: Promise<{ campaign?: string }>;
}) {
  const cwd = process.cwd();
  const params = await searchParams;
  const requestedId = params.campaign ?? null;
  const activeId = await loadActiveCampaignPointer(cwd);
  // Index drives the picker. Read once; it's a single small JSON.
  const index = await loadCampaignIndex(cwd);

  let demo: DemoCampaign | null = null;
  let codeMap: CodeRenderMap | null = null;
  let origin: "campaign" | "demo" = "demo";
  let campaignId: string | null = null;
  // True when the requested id couldn't be loaded — surfaced as a banner.
  let requestedMissing = false;

  // Resolution order: ?campaign=<id> (when present and loadable) → active →
  // demo. The picker lets the operator override "active" without changing
  // the active-pointer file.
  const targetId = requestedId ?? activeId;
  if (targetId) {
    const plan = await loadCampaignPlanIfExists(targetId, cwd);
    if (plan) {
      demo = planToDemoView(plan);
      codeMap = await loadJsonOrNull<CodeRenderMap>(
        path.join(cwd, "data", "campaigns", targetId, "code-render-map.generated.json"),
        CodeRenderMapSchema,
      );
      origin = "campaign";
      campaignId = targetId;
    } else if (requestedId) {
      // Operator explicitly asked for an id that doesn't exist on disk.
      requestedMissing = true;
    }
  }

  if (!demo) {
    demo = await loadJsonOrNull<DemoCampaign>(DEMO_PATH, DemoCampaignSchema);
    codeMap = await loadJsonOrNull<CodeRenderMap>(CODE_MAP_PATH, CodeRenderMapSchema);
    origin = "demo";
  }

  const cloudinaryMap = await loadJsonOrNull<CloudinaryCodeRenderMap>(
    CLOUDINARY_CODE_MAP_PATH,
    CloudinaryCodeRenderMapSchema,
  );

  if (!demo) {
    return (
      <section className="space-y-4">
        <h1 className="text-3xl font-semibold tracking-tight">Code Render Preview</h1>
        <div className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
          <p className="font-medium">No campaign or demo found.</p>
          <p className="mt-1">
            Plan a campaign at <Link className="underline" href="/campaign-planner">/campaign-planner</Link>{" "}
            or run <code>npm run preview:demo</code>.
          </p>
        </div>
      </section>
    );
  }

  const renderByAdId = new Map<string, CodeRenderRecord>();
  for (const r of codeMap?.items ?? []) renderByAdId.set(r.ad_id, r);
  const cloudinaryByAdId = new Map<string, ReturnType<typeof loadCloudinary>>();
  for (const it of cloudinaryMap?.items ?? []) {
    cloudinaryByAdId.set(it.ad_id, loadCloudinary(it));
  }

  return (
    <section className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Code Render Preview</h1>
        <p className="max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">
          Final PNGs rendered directly from the Element Manifest by the code renderer.
          Bannerbear is optional and not used here. The Element Manifest stays the source
          of truth — these PNGs are flat snapshots for distribution.
        </p>
        <p className="text-xs">
          <Link href="/visual-preview" className="text-sky-700 hover:underline dark:text-sky-400">
            ← Local visual preview
          </Link>
          <span className="mx-2 text-zinc-400">·</span>
          <Link href="/campaign-planner" className="text-sky-700 hover:underline dark:text-sky-400">
            Plan a new campaign →
          </Link>
        </p>
      </header>

      <div className="rounded-md border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950">
        <CampaignPicker
          campaigns={index.campaigns}
          selectedId={campaignId}
          activeId={activeId}
          basePath="/code-render-preview"
        />
      </div>

      {requestedMissing && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
          Campaign{" "}
          <code className="font-mono">{requestedId}</code> not found on disk —
          falling back to {origin === "campaign" ? "active campaign" : "the static demo"}.
        </div>
      )}

      {origin === "campaign" && campaignId ? (
        <div className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-200">
          Showing campaign{" "}
          <Link href={`/campaigns/${campaignId}`} className="font-mono underline">
            {campaignId}
          </Link>
          {campaignId === activeId ? (
            <span className="ml-1 rounded bg-emerald-200 px-1.5 py-0.5 text-[10px] font-medium dark:bg-emerald-900/50">active</span>
          ) : (
            <span className="ml-1 rounded bg-zinc-200 px-1.5 py-0.5 text-[10px] font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">picked</span>
          )}{" "}
          — {demo.ad_specs.length} ad spec
          {demo.ad_specs.length === 1 ? "" : "s"}.
        </div>
      ) : (
        <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
          Showing the static demo (no active campaign). Generate one at{" "}
          <Link href="/campaign-planner" className="underline">
            /campaign-planner
          </Link>
          .
        </div>
      )}

      <HowToRun map={codeMap} origin={origin} />

      <ul className="space-y-8">
        {demo.ad_specs.map((spec) => {
          const record = renderByAdId.get(spec.specId) ?? null;
          const cloud = cloudinaryByAdId.get(spec.specId) ?? null;
          return (
            <AdRow key={spec.specId} demo={demo} spec={spec} record={record} cloud={cloud} />
          );
        })}
      </ul>
    </section>
  );
}

function loadCloudinary(it: z.infer<typeof CloudinaryCodeRenderRecordSchema>) {
  return it;
}

function HowToRun({
  map,
  origin,
}: {
  map: CodeRenderMap | null;
  origin: "campaign" | "demo";
}) {
  const renderCmd =
    origin === "campaign" ? "npm run render:code-campaign" : "npm run render:code-demo";
  return (
    <div className="rounded-md border border-zinc-200 bg-zinc-50 p-4 text-sm dark:border-zinc-800 dark:bg-zinc-900">
      <p className="mb-2 font-medium">
        Render the {origin === "campaign" ? "active campaign" : "demo"}
      </p>
      <ol className="list-decimal list-inside space-y-1 text-zinc-700 dark:text-zinc-300">
        <li>
          <code className="rounded bg-zinc-200 px-1 py-0.5 dark:bg-zinc-800">npm run dev</code>
          <span className="ml-2 text-zinc-500">if not already running.</span>
        </li>
        <li>
          <code className="rounded bg-zinc-200 px-1 py-0.5 dark:bg-zinc-800">{renderCmd}</code>
          <span className="ml-2 text-zinc-500">
            captures every ad from <code>/render/ad/&lt;adId&gt;</code>.
          </span>
        </li>
        <li>
          (optional)
          <code className="ml-1 rounded bg-zinc-200 px-1 py-0.5 dark:bg-zinc-800">npm run cloudinary:upload-code-renders</code>
          <span className="ml-2 text-zinc-500">push final PNGs to Cloudinary.</span>
        </li>
      </ol>
      {map && (
        <p className="mt-3 text-xs text-zinc-500">
          Last render: {new Date(map.generated_at).toLocaleString()} ·{" "}
          {map.completed}/{map.total} completed, {map.failed} failed.
        </p>
      )}
    </div>
  );
}

function AdRow({
  demo,
  spec,
  record,
  cloud,
}: {
  demo: DemoCampaign;
  spec: DemoAdSpec;
  record: CodeRenderRecord | null;
  cloud: z.infer<typeof CloudinaryCodeRenderRecordSchema> | null;
}) {
  const sizeKey = `${spec.size.width}x${spec.size.height}`;
  const status = record?.status ?? "not_rendered";

  return (
    <li className="rounded-md border border-zinc-200 p-4 dark:border-zinc-800">
      <header className="mb-3 flex flex-wrap items-baseline gap-3">
        <h2 className="text-lg font-medium">{sizeKey}</h2>
        <span className="text-xs text-zinc-500">{spec.channel}</span>
        <RenderStatusBadge status={status} />
        {record && record.element_manifest_hash && (
          <span className="text-[11px] text-zinc-500">
            manifest: {record.element_manifest_hash}
          </span>
        )}
        <span className="ml-auto text-xs text-zinc-500">specId: {spec.specId}</span>
      </header>

      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <div className="mb-1 text-xs font-medium text-zinc-500">
            Local preview (Element Manifest → HTML)
          </div>
          <AdPreviewCanvas
            manifest={spec.manifest}
            maxWidth={520}
            gradientCssById={
              demo.asset_selection.background_fill.kind === "gradient"
                ? { el_background: demo.asset_selection.background_fill.css }
                : undefined
            }
          />
        </div>
        <div>
          <div className="mb-1 text-xs font-medium text-zinc-500">
            Code-rendered final (PNG)
          </div>
          <FinalPanel record={record} cloud={cloud} />
        </div>
      </div>

      {record && <RenderDetails record={record} cloud={cloud} />}
    </li>
  );
}

function RenderStatusBadge({ status }: { status: string }) {
  const tone =
    status === "completed"
      ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
      : status === "failed"
        ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200"
        : "bg-zinc-100 text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300";
  const label = status === "not_rendered" ? "not rendered" : status;
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>
      {label}
    </span>
  );
}

function FinalPanel({
  record,
  cloud,
}: {
  record: CodeRenderRecord | null;
  cloud: z.infer<typeof CloudinaryCodeRenderRecordSchema> | null;
}) {
  if (!record) {
    return (
      <div className="flex h-64 items-center justify-center rounded-md border border-dashed border-zinc-300 text-xs text-zinc-500 dark:border-zinc-700">
        Not rendered yet. Run <code className="ml-1">npm run render:code-demo</code>.
      </div>
    );
  }
  if (record.status !== "completed" || !record.output_public_path) {
    return (
      <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
        <div className="font-medium">Render failed</div>
        {record.error && <div className="mt-1 break-words">{record.error}</div>}
      </div>
    );
  }
  const src = cloud?.cloudinary_secure_url ?? record.output_public_path;
  return (
    <div className="space-y-2">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt="Code-rendered PNG"
        className="w-full rounded-md ring-1 ring-zinc-300 dark:ring-zinc-700"
      />
      <a
        href={src}
        target="_blank"
        rel="noreferrer"
        className="text-xs text-sky-700 hover:underline dark:text-sky-400"
      >
        Open in new tab ↗
      </a>
    </div>
  );
}

function RenderDetails({
  record,
  cloud,
}: {
  record: CodeRenderRecord;
  cloud: z.infer<typeof CloudinaryCodeRenderRecordSchema> | null;
}) {
  const deliverySource = cloud?.cloudinary_secure_url ? "cloudinary" : "local_preview";
  return (
    <details className="mt-4 rounded-md border border-zinc-200 dark:border-zinc-800">
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium hover:bg-zinc-50 dark:hover:bg-zinc-900">
        Render details
      </summary>
      <div className="space-y-2 p-3 text-xs">
        <Row label="Output path" value={record.output_public_path ?? "—"} />
        <Row
          label="Canvas size"
          value={`${record.canvas_width}×${record.canvas_height}`}
        />
        <Row label="Bytes" value={record.bytes ? record.bytes.toLocaleString() : "—"} />
        <Row label="Rendered at" value={record.rendered_at} />
        <Row label="Source" value={record.source} />
        <Row
          label="Delivery source"
          value={
            deliverySource === "cloudinary" ? (
              <span className="text-emerald-700 dark:text-emerald-400">
                cloudinary · {cloud?.cloudinary_public_id ?? ""}
              </span>
            ) : (
              <span className="text-amber-700 dark:text-amber-400">local_preview</span>
            )
          }
        />
        {record.warnings.length > 0 && (
          <div>
            <div className="mb-1 text-zinc-500">Warnings</div>
            <ul className="list-disc list-inside text-amber-700 dark:text-amber-400">
              {record.warnings.map((w, i) => (
                <li key={i} className="break-words">
                  {w}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </details>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[10rem_1fr] gap-2">
      <div className="text-zinc-500">{label}</div>
      <div className="break-words">{value}</div>
    </div>
  );
}
