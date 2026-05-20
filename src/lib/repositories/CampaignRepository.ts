import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import {
  CampaignPlanSchema,
  type CampaignPlan,
  type CampaignIndexEntry,
} from "@/lib/schemas/aiCampaignPlan.schema";

// ─────────────────────────────────────────────────────────────────────────────
// Campaign repository.
//
// One interface, two implementations:
//   - LocalCampaignRepository   → reads / writes data/campaigns/{id}/
//                                  + data/campaigns/index.generated.json
//                                  + data/active-campaign.generated.json
//   - SupabaseCampaignRepository → reads / writes the `campaigns` table.
//
// Production fails closed: getCampaignRepository() throws when NODE_ENV
// is "production" and the supabase env vars are missing, OR when the env
// asks for the local driver. The legacy filesystem helpers in
// `@/lib/ai/campaignPlanner.ts` still exist for backwards compatibility but
// every new caller should go through this repository.
// ─────────────────────────────────────────────────────────────────────────────

export interface CampaignIndexEntryExtended extends CampaignIndexEntry {
  updated_at?: string;
  version?: number;
}

export interface CampaignRepository {
  readonly driver: "local" | "supabase";

  listCampaigns(): Promise<CampaignIndexEntryExtended[]>;

  getCampaign(campaignId: string): Promise<CampaignPlan | null>;

  // Insert a brand-new plan. Throws if the campaign_id already exists.
  insertCampaign(plan: CampaignPlan): Promise<{ version: number }>;

  // Update an existing plan. Optimistic concurrency: if expectedVersion is
  // supplied and does not match the stored version, throws.
  updateCampaign(
    plan: CampaignPlan,
    expectedVersion?: number,
  ): Promise<{ version: number }>;

  getActiveCampaignId(): Promise<string | null>;
  setActiveCampaign(campaignId: string): Promise<void>;
}

// ─── Local FS implementation (dev only) ─────────────────────────────────────
class LocalCampaignRepository implements CampaignRepository {
  readonly driver = "local" as const;

  constructor(private readonly cwd: string = process.cwd()) {}

  private planPath(id: string): string {
    return path.join(this.cwd, "data", "campaigns", id, "campaign-plan.json");
  }
  private indexPath(): string {
    return path.join(this.cwd, "data", "campaigns", "index.generated.json");
  }
  private activePath(): string {
    return path.join(this.cwd, "data", "active-campaign.generated.json");
  }

  async listCampaigns(): Promise<CampaignIndexEntryExtended[]> {
    try {
      const raw = await fs.readFile(this.indexPath(), "utf8");
      const parsed = JSON.parse(raw) as {
        campaigns: CampaignIndexEntry[];
      };
      return parsed.campaigns ?? [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  async getCampaign(id: string): Promise<CampaignPlan | null> {
    try {
      const raw = await fs.readFile(this.planPath(id), "utf8");
      return CampaignPlanSchema.parse(JSON.parse(raw));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async insertCampaign(plan: CampaignPlan): Promise<{ version: number }> {
    // Local impl uses a JSON file; concurrency control is informational.
    const existing = await this.getCampaign(plan.campaign_id);
    if (existing) {
      throw new Error(`campaign ${plan.campaign_id} already exists`);
    }
    await this.writePlan(plan);
    await this.upsertIndex(plan, 1);
    return { version: 1 };
  }

  async updateCampaign(
    plan: CampaignPlan,
    expectedVersion?: number,
  ): Promise<{ version: number }> {
    const current = await this.getCampaign(plan.campaign_id);
    if (!current) throw new Error(`campaign ${plan.campaign_id} not found`);
    // Local repo doesn't persist a version yet; treat any expected version
    // as "ok" but increment monotonically based on file mtime.
    if (expectedVersion !== undefined) {
      // Best-effort consistency check.
      void expectedVersion;
    }
    await this.writePlan(plan);
    const stat = await fs.stat(this.planPath(plan.campaign_id));
    const version = Math.floor(stat.mtimeMs);
    await this.upsertIndex(plan, version);
    return { version };
  }

  private async writePlan(plan: CampaignPlan): Promise<void> {
    const file = this.planPath(plan.campaign_id);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp.${Date.now()}`;
    await fs.writeFile(tmp, JSON.stringify(plan, null, 2) + "\n", "utf8");
    await fs.rename(tmp, file);
  }

  private async upsertIndex(plan: CampaignPlan, _version: number): Promise<void> {
    void _version;
    const idx = this.indexPath();
    let current: {
      generated_at: string;
      active_campaign_id: string | null;
      campaigns: CampaignIndexEntry[];
    };
    try {
      const raw = await fs.readFile(idx, "utf8");
      current = JSON.parse(raw);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      current = {
        generated_at: new Date().toISOString(),
        active_campaign_id: null,
        campaigns: [],
      };
    }
    const ad_count = plan.concepts.reduce((acc, c) => acc + c.ad_specs.length, 0);
    const entry: CampaignIndexEntry = {
      campaign_id: plan.campaign_id,
      brand_id: plan.brand_id,
      campaign_name: plan.campaign_name,
      ai_provider: plan.ai_provider,
      concept_count: plan.concepts.length,
      ad_count,
      created_at: plan.created_at,
      active: current.active_campaign_id === plan.campaign_id,
      rendered: false,
    };
    const next = {
      generated_at: new Date().toISOString(),
      active_campaign_id: current.active_campaign_id,
      campaigns: [
        entry,
        ...current.campaigns.filter((c) => c.campaign_id !== plan.campaign_id),
      ],
    };
    await fs.mkdir(path.dirname(idx), { recursive: true });
    const tmp = `${idx}.tmp.${Date.now()}`;
    await fs.writeFile(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
    await fs.rename(tmp, idx);
  }

  async getActiveCampaignId(): Promise<string | null> {
    try {
      const raw = await fs.readFile(this.activePath(), "utf8");
      const j = JSON.parse(raw) as { campaign_id?: unknown };
      return typeof j.campaign_id === "string" ? j.campaign_id : null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }
  async setActiveCampaign(campaignId: string): Promise<void> {
    const idx = this.indexPath();
    let current: {
      generated_at: string;
      active_campaign_id: string | null;
      campaigns: CampaignIndexEntry[];
    };
    try {
      const raw = await fs.readFile(idx, "utf8");
      current = JSON.parse(raw);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      current = {
        generated_at: new Date().toISOString(),
        active_campaign_id: null,
        campaigns: [],
      };
    }
    const next = {
      generated_at: new Date().toISOString(),
      active_campaign_id: campaignId,
      campaigns: current.campaigns.map((c) => ({
        ...c,
        active: c.campaign_id === campaignId,
      })),
    };
    const tmp = `${idx}.tmp.${Date.now()}`;
    await fs.writeFile(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
    await fs.rename(tmp, idx);
    const activeFile = {
      campaign_id: campaignId,
      pointer_path: path.relative(this.cwd, this.planPath(campaignId)),
      set_at: new Date().toISOString(),
    };
    await fs.writeFile(
      this.activePath(),
      JSON.stringify(activeFile, null, 2) + "\n",
      "utf8",
    );
  }
}

// ─── Supabase implementation ─────────────────────────────────────────────────
//
// Backing table (see migrations/0001_campaigns.sql):
//
//   campaigns (
//     campaign_id text primary key,
//     brand_id    text not null,
//     plan        jsonb not null,
//     ai_provider text not null,
//     created_at  timestamptz not null default now(),
//     updated_at  timestamptz not null default now(),
//     version     integer not null default 1
//   )
//   active_campaign (
//     id  integer primary key default 1,
//     campaign_id text references campaigns(campaign_id)
//   )
//
class SupabaseCampaignRepository implements CampaignRepository {
  readonly driver = "supabase" as const;
  private client: ReturnType<typeof createClient>;

  constructor(url: string, serviceRoleKey: string) {
    this.client = createClient(url, serviceRoleKey, {
      auth: { persistSession: false },
    });
  }

  async listCampaigns(): Promise<CampaignIndexEntryExtended[]> {
    const { data, error } = await this.client
      .from("campaigns")
      .select(
        "campaign_id, brand_id, plan, ai_provider, created_at, updated_at, version",
      )
      .order("created_at", { ascending: false });
    if (error) throw new Error(`supabase campaigns list failed: ${error.message}`);
    const activeId = await this.getActiveCampaignId();
    const rows = (data ?? []) as Array<{
      campaign_id: string;
      brand_id: string;
      plan: unknown;
      ai_provider: "openai" | "anthropic" | "mock";
      created_at: string;
      updated_at: string;
      version: number;
    }>;
    return rows.map((r) => {
      const plan = r.plan as CampaignPlan;
      const ad_count = plan.concepts.reduce(
        (acc, c) => acc + c.ad_specs.length,
        0,
      );
      return {
        campaign_id: r.campaign_id,
        brand_id: r.brand_id,
        campaign_name: plan.campaign_name,
        ai_provider: r.ai_provider,
        concept_count: plan.concepts.length,
        ad_count,
        created_at: r.created_at,
        active: r.campaign_id === activeId,
        rendered: false,
        updated_at: r.updated_at,
        version: r.version,
      };
    });
  }

  async getCampaign(id: string): Promise<CampaignPlan | null> {
    const { data, error } = await this.client
      .from("campaigns")
      .select("plan")
      .eq("campaign_id", id)
      .maybeSingle();
    if (error) throw new Error(`supabase get campaign failed: ${error.message}`);
    if (!data) return null;
    return CampaignPlanSchema.parse((data as { plan: unknown }).plan);
  }

  async insertCampaign(plan: CampaignPlan): Promise<{ version: number }> {
    const { data, error } = await this.client
      .from("campaigns")
      .insert({
        campaign_id: plan.campaign_id,
        brand_id: plan.brand_id,
        plan,
        ai_provider: plan.ai_provider,
        version: 1,
      } as never)
      .select("version")
      .single();
    if (error) throw new Error(`supabase insert failed: ${error.message}`);
    return { version: (data as { version: number }).version };
  }

  async updateCampaign(
    plan: CampaignPlan,
    expectedVersion?: number,
  ): Promise<{ version: number }> {
    // Postgres-side optimistic concurrency via the `version` column.
    let q = this.client
      .from("campaigns")
      .update({
        plan,
        ai_provider: plan.ai_provider,
        updated_at: new Date().toISOString(),
        version: (expectedVersion ?? 0) + 1,
      } as never)
      .eq("campaign_id", plan.campaign_id);
    if (expectedVersion !== undefined) {
      q = q.eq("version", expectedVersion);
    }
    const { data, error } = await q.select("version").maybeSingle();
    if (error) throw new Error(`supabase update failed: ${error.message}`);
    if (!data) {
      throw new Error(
        `supabase update conflict: campaign ${plan.campaign_id} version ${expectedVersion} did not match`,
      );
    }
    return { version: (data as { version: number }).version };
  }

  async getActiveCampaignId(): Promise<string | null> {
    const { data, error } = await this.client
      .from("active_campaign")
      .select("campaign_id")
      .eq("id", 1)
      .maybeSingle();
    if (error) throw new Error(`supabase get active failed: ${error.message}`);
    if (!data) return null;
    return (data as { campaign_id: string | null }).campaign_id ?? null;
  }

  async setActiveCampaign(campaignId: string): Promise<void> {
    const { error } = await this.client
      .from("active_campaign")
      .upsert({ id: 1, campaign_id: campaignId } as never);
    if (error) throw new Error(`supabase set active failed: ${error.message}`);
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────
export function getCampaignRepository(): CampaignRepository {
  const driver = (process.env.CAMPAIGN_REPO_DRIVER ?? "").toLowerCase();
  const isProd = process.env.NODE_ENV === "production";

  if (driver === "supabase" || (isProd && driver !== "local")) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error(
        "CampaignRepository: Supabase driver requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
      );
    }
    return new SupabaseCampaignRepository(url, key);
  }

  if (isProd && process.env.ALLOW_LOCAL_FS_WRITES !== "true") {
    throw new Error(
      "CampaignRepository: refusing to use local filesystem in production. Set CAMPAIGN_REPO_DRIVER=supabase or (only for emergencies) ALLOW_LOCAL_FS_WRITES=true.",
    );
  }
  return new LocalCampaignRepository();
}
