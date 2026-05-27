import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  CampaignBriefInputSchema,
  CampaignBriefSchema,
  type CampaignBrief,
} from "@/lib/schemas/campaignBrief.schema";
import {
  planCampaign,
  type PlanProgressEvent,
} from "@/lib/ai/campaignPlanner";
import { readProviderName } from "@/lib/ai/provider";

// POST /api/generate-campaign-variants
//
// Runs `planCampaign` N times against the SAME brief, each with a different
// `diversity_seed`, so the operator can compare 3 variants of the same
// strategy (or skim 9 different concept-flavours when N=3 × 3 concepts).
//
// Body:
//   {
//     brief: CampaignBriefInput,
//     ai_provider?: "mock" | "openai" | "anthropic",
//     count?: number          // default 3, capped at 5 (cost protection)
//     set_first_active?: boolean   // default false
//   }
//
// Response format depends on the request's `Accept` header:
//
//   • Accept: application/x-ndjson — streamed NDJSON. Per-variant stage
//     events carry `variant` (1-based) and `of` (total count) fields so
//     the UI can render "Variant 2/3 — Translating concept 1 of 3…".
//     After each variant: {"type":"variant_done", ok, variant, campaign_id, …}.
//     The terminal event is {"type":"done", ok, variants, errors, base_seed}.
//
//   • Default — synchronous JSON, unchanged contract for scripts.
//
// Cost note: each variant runs the full 3-pass AI pipeline. With openai
// that's ~$0.05 in tokens per variant, so 3 variants ≈ $0.15. The cap of 5
// is intentional to keep accidental clicks from spending dollars.

const RequestSchema = z.object({
  brief: CampaignBriefInputSchema,
  ai_provider: z.enum(["mock", "openai", "anthropic"]).optional(),
  count: z.number().int().min(1).max(5).optional(),
  set_first_active: z.boolean().optional(),
});

export const maxDuration = 600;

interface VariantSummary {
  campaign_id: string;
  campaign_name: string;
  diversity_seed: number;
  saved_path: string;
}

interface VariantError {
  index: number;
  message: string;
}

export async function POST(request: Request) {
  const json = await request.json().catch(() => null);
  const parsed = RequestSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "invalid_request", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const count = parsed.data.count ?? 3;
  const provider = parsed.data.ai_provider ?? readProviderName();
  const setFirstActive = parsed.data.set_first_active ?? false;
  const baseSeed =
    parsed.data.brief.diversity_seed ?? Math.floor(Math.random() * 1_000_000);
  const wantsStream = request.headers.get("accept")?.includes("application/x-ndjson");

  // Inline runner so both streaming and non-streaming paths reuse the
  // same per-variant logic. `onEvent` is invoked synchronously for every
  // stage / variant_done event the streaming path needs; the JSON path
  // passes a no-op.
  const runAll = async (
    onEvent: (
      ev:
        | { type: "stage"; variant: number; of: number; stage: string; detail?: string }
        | { type: "variant_done"; ok: true; variant: number; of: number; campaign_id: string; campaign_name: string; diversity_seed: number }
        | { type: "variant_done"; ok: false; variant: number; of: number; message: string },
    ) => void,
  ): Promise<{ variants: VariantSummary[]; errors: VariantError[] }> => {
    const variants: VariantSummary[] = [];
    const errors: VariantError[] = [];
    for (let i = 0; i < count; i++) {
      const seed = (baseSeed + i * 100003) % 2_000_000;
      const brief: CampaignBrief = CampaignBriefSchema.parse({
        ...parsed.data.brief,
        brief_id: `brief_${crypto.randomBytes(6).toString("hex")}`,
        created_at: new Date().toISOString(),
        diversity_seed: seed,
      });
      try {
        const result = await planCampaign({
          brief,
          providerName: provider,
          setAsActive: setFirstActive && i === 0,
          onProgress: (ev: PlanProgressEvent) =>
            onEvent({
              type: "stage",
              variant: i + 1,
              of: count,
              stage: ev.stage,
              detail: ev.detail,
            }),
        });
        variants.push({
          campaign_id: result.plan.campaign_id,
          campaign_name: result.plan.campaign_name,
          diversity_seed: seed,
          saved_path: result.saved_path,
        });
        onEvent({
          type: "variant_done",
          ok: true,
          variant: i + 1,
          of: count,
          campaign_id: result.plan.campaign_id,
          campaign_name: result.plan.campaign_name,
          diversity_seed: seed,
        });
      } catch (err) {
        const message = redact((err as Error).message);
        errors.push({ index: i, message });
        onEvent({
          type: "variant_done",
          ok: false,
          variant: i + 1,
          of: count,
          message,
        });
      }
    }
    return { variants, errors };
  };

  if (!wantsStream) {
    const { variants, errors } = await runAll(() => {});
    if (variants.length === 0) {
      return NextResponse.json(
        { ok: false, error: "all_variants_failed", errors },
        { status: 500 },
      );
    }
    return NextResponse.json({ ok: true, base_seed: baseSeed, variants, errors });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (obj: unknown) =>
        controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      try {
        const { variants, errors } = await runAll(write);
        write({
          type: "done",
          ok: variants.length > 0,
          base_seed: baseSeed,
          variants,
          errors,
          ...(variants.length === 0 ? { error: "all_variants_failed" } : {}),
        });
      } catch (err) {
        // runAll already catches per-variant errors; anything reaching
        // here is a process-level failure (e.g. crypto.randomBytes throws).
        write({
          type: "done",
          ok: false,
          error: "planner_failed",
          message: redact((err as Error).message),
          variants: [],
          errors: [],
        });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}

function redact(s: string): string {
  return s
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/api_key=[^&\s)]*/gi, "api_key=[redacted]")
    .replace(/sk-[A-Za-z0-9._-]{8,}/g, "sk-[redacted]");
}
