import { z } from "zod";
import {
  createBannerbearImage,
  pollBannerbearImage,
  type BannerbearImageResponse,
} from "@/lib/bannerbear/client";
import {
  getBannerbearTemplateUidForFormat,
  isSupportedFormat,
  type SupportedFormat,
} from "@/lib/bannerbear/templateMapping";
import {
  convertElementManifestToBannerbearModifications,
  ConversionDiagnosticsSchema,
  type ConversionDiagnostics,
} from "@/lib/bannerbear/convertManifestToModifications";
import {
  BannerbearModificationSchema,
  BannerbearRenderStatusSchema,
  type BannerbearModification,
  type BannerbearRenderStatus,
} from "@/lib/schemas/bannerbear.schema";
import { ElementManifestSchema } from "@/lib/schemas/elementManifest.schema";

// ─────────────────────────────────────────────────────────────────────────────
// Render one ad through Bannerbear.
//
// Flow:
//   1. Validate the AdSpec input (schema-only, no network).
//   2. Resolve the template UID for the AdSpec's size.
//   3. Convert the Element Manifest → Bannerbear modifications.
//   4. POST /v2/images and poll until completed/failed (or timeout).
//   5. Return a single BannerbearRenderRecord-shaped result + diagnostics.
//
// Re-exports the legacy `BannerbearRenderRequestSchema` / `renderAd()` shapes
// so existing route handlers keep compiling.
// ─────────────────────────────────────────────────────────────────────────────

export {
  BannerbearModificationSchema,
  type BannerbearModification,
} from "@/lib/schemas/bannerbear.schema";

// Legacy request/result shapes consumed by /api/render-ad/route.ts.
export const BannerbearRenderRequestSchema = z.object({
  templateUid: z.string().min(1),
  modifications: z.array(BannerbearModificationSchema).default([]),
  metadata: z.record(z.string(), z.string()).optional(),
});
export type BannerbearRenderRequest = z.infer<typeof BannerbearRenderRequestSchema>;

export const BannerbearRenderResultSchema = z.object({
  uid: z.string().min(1),
  status: z.string().min(1),
  imageUrl: z.string().url().nullable(),
});
export type BannerbearRenderResult = z.infer<typeof BannerbearRenderResultSchema>;

/** Thin one-shot wrapper around the API for callers with hand-built modifications. */
export async function renderAd(
  req: BannerbearRenderRequest,
): Promise<BannerbearRenderResult> {
  const created = await createBannerbearImage({
    template: req.templateUid,
    modifications: req.modifications,
    metadata: req.metadata ? JSON.stringify(req.metadata) : undefined,
  });
  const polled = await pollBannerbearImage(created.uid);
  return BannerbearRenderResultSchema.parse({
    uid: polled.finalResponse.uid,
    status: polled.finalResponse.status,
    imageUrl:
      polled.finalResponse.image_url ??
      polled.finalResponse.image_url_png ??
      polled.finalResponse.image_url_jpg ??
      null,
  });
}

// ── AdSpec → render record (the public entry point) ────────────────────────
// We accept a flexible AdSpec shape because callers may pass either the
// DemoAdSpec (from data/demo-campaign.preview.json) or a hand-built record.
// The only fields we *require* are specId, size, and manifest.
export const RenderableAdSpecSchema = z.object({
  specId: z.string().min(1),
  size: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  channel: z.string().optional(),
  bannerbearTemplateUid: z.string().optional(),
  manifest: ElementManifestSchema,
});
export type RenderableAdSpec = z.infer<typeof RenderableAdSpecSchema>;

export const RenderAdResultSchema = z.object({
  ad_id: z.string(),
  format: z.string(),
  template_uid: z.string(),
  template_uid_source: z.enum(["env", "template_map", "ad_spec"]),
  modifications_sent: z.array(BannerbearModificationSchema),
  conversion_diagnostics: ConversionDiagnosticsSchema,
  bannerbear_image_uid: z.string().nullable(),
  bannerbear_render_response: z.record(z.string(), z.unknown()).nullable(),
  final_render_url: z.string().url().nullable(),
  status: BannerbearRenderStatusSchema,
  rendered_at: z.string(),
  error: z.string().optional(),
});
export type RenderAdResult = z.infer<typeof RenderAdResultSchema>;

export interface RenderAdOptions {
  // If true, a missing/required-layer issue or local URL still attempts the
  // Bannerbear call. Default false — we abort early to save credits.
  attemptOnDiagnosticErrors?: boolean;
  // Ad ID for the record. Defaults to the spec's `specId`.
  adId?: string;
}

/**
 * Render one ad. Catches conversion + API errors and returns a record with
 * `status: "failed"` instead of throwing — so a multi-ad pipeline can keep
 * going.
 */
export async function renderAdWithBannerbear(
  rawSpec: unknown,
  opts: RenderAdOptions = {},
): Promise<RenderAdResult> {
  const renderedAt = new Date().toISOString();
  const attemptOnErrors = opts.attemptOnDiagnosticErrors ?? false;

  // 1. Validate input.
  const parsedSpec = RenderableAdSpecSchema.safeParse(rawSpec);
  if (!parsedSpec.success) {
    return RenderAdResultSchema.parse({
      ad_id: opts.adId ?? "unknown",
      format: "unknown",
      template_uid: "",
      template_uid_source: "ad_spec",
      modifications_sent: [],
      conversion_diagnostics: emptyDiagnostics(),
      bannerbear_image_uid: null,
      bannerbear_render_response: null,
      final_render_url: null,
      status: "failed" as BannerbearRenderStatus,
      rendered_at: renderedAt,
      error: `AdSpec failed validation: ${formatZodIssues(parsedSpec.error.issues)}`,
    });
  }
  const spec = parsedSpec.data;
  const ad_id = opts.adId ?? spec.specId;
  const format = `${spec.size.width}x${spec.size.height}`;

  // 2. Resolve template UID. AdSpec wins if it carries a non-placeholder UID.
  let templateUid: string;
  let templateUidSource: "env" | "template_map" | "ad_spec";
  if (
    spec.bannerbearTemplateUid &&
    !spec.bannerbearTemplateUid.startsWith("placeholder_") &&
    !spec.bannerbearTemplateUid.startsWith("REPLACE_WITH")
  ) {
    templateUid = spec.bannerbearTemplateUid;
    templateUidSource = "ad_spec";
  } else if (isSupportedFormat(format)) {
    try {
      const resolved = await getBannerbearTemplateUidForFormat(format);
      templateUid = resolved.template_uid;
      templateUidSource = resolved.source;
    } catch (err) {
      return failureRecord({
        ad_id,
        format,
        renderedAt,
        error: (err as Error).message,
      });
    }
  } else {
    return failureRecord({
      ad_id,
      format,
      renderedAt,
      error: `Unsupported ad format "${format}".`,
    });
  }

  // 3. Convert the manifest to modifications.
  const { modifications, diagnostics } =
    convertElementManifestToBannerbearModifications(spec.manifest);

  if (diagnostics.local_url_errors.length > 0 && !attemptOnErrors) {
    return RenderAdResultSchema.parse({
      ad_id,
      format,
      template_uid: templateUid,
      template_uid_source: templateUidSource,
      modifications_sent: modifications,
      conversion_diagnostics: diagnostics,
      bannerbear_image_uid: null,
      bannerbear_render_response: null,
      final_render_url: null,
      status: "failed" as BannerbearRenderStatus,
      rendered_at: renderedAt,
      error: `Local URLs found in manifest: ${diagnostics.local_url_errors[0]}`,
    });
  }

  // 4 + 5. Hit Bannerbear, poll, and shape the result.
  let response: BannerbearImageResponse;
  try {
    const created = await createBannerbearImage({
      template: templateUid,
      modifications,
      metadata: JSON.stringify({ ad_id, format }),
    });
    const polled = await pollBannerbearImage(created.uid);
    response = polled.finalResponse;
  } catch (err) {
    return RenderAdResultSchema.parse({
      ad_id,
      format,
      template_uid: templateUid,
      template_uid_source: templateUidSource,
      modifications_sent: modifications,
      conversion_diagnostics: diagnostics,
      bannerbear_image_uid: null,
      bannerbear_render_response: null,
      final_render_url: null,
      status: "failed" as BannerbearRenderStatus,
      rendered_at: renderedAt,
      error: (err as Error).message,
    });
  }

  const status = mapStatus(response.status);
  const finalUrl =
    response.image_url ?? response.image_url_png ?? response.image_url_jpg ?? null;

  return RenderAdResultSchema.parse({
    ad_id,
    format,
    template_uid: templateUid,
    template_uid_source: templateUidSource,
    modifications_sent: modifications,
    conversion_diagnostics: diagnostics,
    bannerbear_image_uid: response.uid,
    bannerbear_render_response: response as unknown as Record<string, unknown>,
    final_render_url: finalUrl,
    status,
    rendered_at: renderedAt,
  });
}

function mapStatus(s: string): BannerbearRenderStatus {
  if (s === "completed") return "completed";
  if (s === "failed") return "failed";
  if (s === "rendering") return "rendering";
  return "pending";
}

function emptyDiagnostics(): ConversionDiagnostics {
  return {
    mapped_layers: [],
    missing_layers: [],
    local_url_errors: [],
    unsupported_properties: [],
    warnings: [],
  };
}

function formatZodIssues(issues: { path: PropertyKey[]; message: string }[]): string {
  return issues
    .map((i) => `${i.path.map((p) => String(p)).join(".")}: ${i.message}`)
    .join("; ");
}

function failureRecord(args: {
  ad_id: string;
  format: string;
  renderedAt: string;
  error: string;
}): RenderAdResult {
  return RenderAdResultSchema.parse({
    ad_id: args.ad_id,
    format: args.format,
    template_uid: "",
    template_uid_source: "ad_spec",
    modifications_sent: [],
    conversion_diagnostics: emptyDiagnostics(),
    bannerbear_image_uid: null,
    bannerbear_render_response: null,
    final_render_url: null,
    status: "failed",
    rendered_at: args.renderedAt,
    error: args.error,
  });
}
