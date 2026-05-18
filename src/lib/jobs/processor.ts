import "server-only";
import { getJobRepository } from "@/lib/jobs/JobRepository";
import type { Job } from "@/lib/jobs/types";
import { loadCampaignPlanIfExists } from "@/lib/ai/campaignPlanner";
import { renderCampaign } from "@/lib/render/renderCampaign";
import { exportCampaignPlanZip } from "@/lib/export/exportCampaignPlan";
import { getAssetStorage } from "@/lib/storage/AssetStorage";
import { promises as fs } from "node:fs";
import path from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Job processor. Knows how to run each Job.type. Pure async function — wrap
// it in a polling loop (the worker script) or call it inline from a route
// when WORKER_INLINE=true.
// ─────────────────────────────────────────────────────────────────────────────

export async function processJob(job: Job): Promise<unknown> {
  switch (job.type) {
    case "render":
      return processRender(job);
    case "variants":
      return processVariants(job);
    case "export":
      return processExport(job);
  }
}

interface RenderJobInput {
  campaign_id: string;
  base_url?: string;
}

async function processRender(job: Job): Promise<unknown> {
  const input = job.input as RenderJobInput;
  if (!input?.campaign_id) throw new Error("render job: missing campaign_id");
  const plan = await loadCampaignPlanIfExists(input.campaign_id);
  if (!plan) throw new Error(`render job: campaign ${input.campaign_id} not found`);
  const baseUrl =
    input.base_url ??
    process.env.RENDER_BASE_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    "http://localhost:3000";
  const result = await renderCampaign(plan, baseUrl, {
    onProgress: async (rec) => {
      // Compute progress fraction as (records so far / total ads).
      const total = plan.concepts.reduce(
        (acc, c) => acc + c.ad_specs.length,
        0,
      );
      const repo = getJobRepository();
      try {
        const current = await repo.get(job.id);
        if (current && current.status === "running") {
          const completedSoFar = (current.progress * total) + 1;
          await repo.updateProgress(job.id, Math.min(0.99, completedSoFar / total));
        }
      } catch {
        // best-effort progress update
      }
      void rec;
    },
  });
  return {
    total: result.map.total,
    completed: result.map.completed,
    failed: result.map.failed,
    output_dir: result.output_dir,
    items_count: result.map.items.length,
  };
}

interface ExportJobInput {
  campaign_id: string;
  upload_to_storage?: boolean;
}

async function processExport(job: Job): Promise<unknown> {
  const input = job.input as ExportJobInput;
  if (!input?.campaign_id) throw new Error("export job: missing campaign_id");
  const plan = await loadCampaignPlanIfExists(input.campaign_id);
  if (!plan) throw new Error(`export job: campaign ${input.campaign_id} not found`);

  // Refuse to export if render artifacts are missing. The export job builds
  // the ZIP from the existing PNGs; it does NOT trigger a render.
  const renderMapPath = path.join(
    process.cwd(),
    "data",
    "campaigns",
    plan.campaign_id,
    "code-render-map.generated.json",
  );
  try {
    await fs.access(renderMapPath);
  } catch {
    throw new Error(
      `export job: campaign ${plan.campaign_id} has no rendered PNGs. Run a render job first.`,
    );
  }

  const result = await exportCampaignPlanZip({ plan });

  // Optionally upload the artifact to object storage so the eventual
  // download can come from a signed URL instead of the dev server.
  let stored_key: string | null = null;
  let signed_url: string | null = null;
  if (input.upload_to_storage) {
    try {
      const storage = getAssetStorage("exports");
      const key = `${plan.campaign_id}/${Date.now()}-${result.filename}`;
      const put = await storage.put(key, Buffer.from(result.buffer), "application/zip");
      stored_key = put.key;
      signed_url = put.signed_url ?? put.public_url;
    } catch (err) {
      // Surface upload failure on the job result, but don't fail the export
      // itself — the artifact still exists in memory for download.
      console.warn("export upload failed:", (err as Error).message);
    }
  }

  return {
    filename: result.filename,
    byte_length: result.byteLength,
    stored_key,
    signed_url,
  };
}

interface VariantsJobInput {
  brief: unknown;
  count?: number;
  ai_provider?: "mock" | "openai" | "anthropic";
  set_first_active?: boolean;
}

async function processVariants(job: Job): Promise<unknown> {
  const input = job.input as VariantsJobInput;
  if (!input?.brief) throw new Error("variants job: missing brief");
  const { planCampaign } = await import("@/lib/ai/campaignPlanner");
  const { CampaignBriefSchema } = await import("@/lib/schemas/campaignBrief.schema");
  const { readProviderName } = await import("@/lib/ai/provider");
  const count = Math.max(1, Math.min(5, input.count ?? 3));
  const provider = input.ai_provider ?? readProviderName();
  const variants: Array<{ campaign_id: string; campaign_name: string; saved_path: string }> = [];
  const errors: Array<{ index: number; message: string }> = [];
  for (let i = 0; i < count; i++) {
    try {
      const briefParsed = CampaignBriefSchema.parse(input.brief);
      const result = await planCampaign({
        brief: briefParsed,
        providerName: provider,
        setAsActive: !!input.set_first_active && i === 0,
      });
      variants.push({
        campaign_id: result.plan.campaign_id,
        campaign_name: result.plan.campaign_name,
        saved_path: result.saved_path,
      });
      await getJobRepository().updateProgress(job.id, (i + 1) / count);
    } catch (err) {
      errors.push({ index: i, message: (err as Error).message });
    }
  }
  return { variants, errors };
}
