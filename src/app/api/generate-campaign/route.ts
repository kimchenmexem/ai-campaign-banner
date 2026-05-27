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

// POST /api/generate-campaign
//
// Body: { brief: CampaignBriefInput, ai_provider?, set_as_active? }
//
// Response format depends on the request's `Accept` header:
//
//   • Accept: application/x-ndjson  — streamed NDJSON. One JSON object per
//     line. Stages flow as the planner progresses:
//        {"type":"stage","stage":"ai_concepts"}
//        {"type":"stage","stage":"translating","detail":"concept 1 of 3"}
//        ...
//        {"type":"done","ok":true,"campaign_id":"cam_...","plan":{...}}
//     On failure: {"type":"done","ok":false,"error":"planner_failed","message":"..."}.
//     The form uses this path so it can show live stage indicators.
//
//   • Anything else (default) — original synchronous JSON response. Kept
//     for scripts, cron jobs, the variants route, and anything that calls
//     this endpoint without setting Accept.

const RequestSchema = z.object({
  brief: CampaignBriefInputSchema,
  ai_provider: z.enum(["mock", "openai", "anthropic"]).optional(),
  set_as_active: z.boolean().optional(),
  // Deprecated and ignored. Campaign backgrounds are locked to
  // brand-input/background assets; this field is kept only so older clients
  // don't fail request validation.
  auto_generate_images: z.boolean().optional(),
});

export async function POST(request: Request) {
  const json = await request.json().catch(() => null);
  const parsed = RequestSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "invalid_request", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  // Stamp a brief_id + created_at, then re-validate as a full CampaignBrief.
  const brief: CampaignBrief = CampaignBriefSchema.parse({
    ...parsed.data.brief,
    brief_id: `brief_${crypto.randomBytes(6).toString("hex")}`,
    created_at: new Date().toISOString(),
  });

  const planOpts = {
    brief,
    providerName: parsed.data.ai_provider ?? readProviderName(),
    setAsActive: parsed.data.set_as_active ?? false,
    imageProvider: "none" as const,
  };

  const wantsStream = request.headers.get("accept")?.includes("application/x-ndjson");

  if (!wantsStream) {
    // Legacy synchronous path — preserves the script / variants contract.
    try {
      const result = await planCampaign(planOpts);
      return NextResponse.json({
        ok: true,
        campaign_id: result.plan.campaign_id,
        plan: result.plan,
        saved_path: result.saved_path,
        active: result.active,
        images: result.images,
      });
    } catch (err) {
      return NextResponse.json(
        {
          ok: false,
          error: "planner_failed",
          message: redact((err as Error).message),
        },
        { status: 500 },
      );
    }
  }

  // Streaming path — emit NDJSON stage events while the planner runs,
  // then a final {type:"done"} event with either the success payload or
  // the redacted error. We always return 200 on the streaming path so
  // the client can read the body and distinguish success/failure via
  // the `ok` field of the terminal event (a mid-stream HTTP status flip
  // is not possible). Clients should treat type:"done" with ok:false as
  // a planner error and surface `message` to the operator.
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (obj: unknown) =>
        controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      try {
        const result = await planCampaign({
          ...planOpts,
          onProgress: (event: PlanProgressEvent) =>
            write({ type: "stage", ...event }),
        });
        write({
          type: "done",
          ok: true,
          campaign_id: result.plan.campaign_id,
          plan: result.plan,
          saved_path: result.saved_path,
          active: result.active,
          images: result.images,
        });
      } catch (err) {
        write({
          type: "done",
          ok: false,
          error: "planner_failed",
          message: redact((err as Error).message),
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
      // Disable buffering at any intermediate proxy so stage events
      // reach the browser as soon as they're written.
      "X-Accel-Buffering": "no",
    },
  });
}

// Strip `Bearer ...` / `api_key=...` / `sk-...` from any error surface before
// it gets returned to the client.
function redact(s: string): string {
  return s
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/api_key=[^&\s)]*/gi, "api_key=[redacted]")
    .replace(/sk-[A-Za-z0-9._-]{8,}/g, "sk-[redacted]");
}
