import {
  DemoCampaignSchema,
  type DemoCampaign,
} from "@/lib/preview/createDemoCampaign";
import type { CampaignPlan } from "@/lib/schemas/aiCampaignPlan.schema";
import type { Element } from "@/lib/schemas/elementManifest.schema";

// ─────────────────────────────────────────────────────────────────────────────
// CampaignPlan → DemoCampaign adapter.
//
// /visual-preview and /code-render-preview already know how to render a
// DemoCampaign. This adapter lets them transparently render an AI-generated
// CampaignPlan by projecting it into the same shape: every (concept × format)
// ad becomes a DemoAdSpec keyed by ad_id.
//
// The Element Manifest passes through untouched — it stays the source of truth
// in both shapes. Only the surrounding metadata is repackaged.
// ─────────────────────────────────────────────────────────────────────────────

export function planToDemoView(plan: CampaignPlan): DemoCampaign {
  const ad_specs = plan.concepts.flatMap((c) =>
    c.ad_specs.map((a) => ({
      specId: a.ad_id,
      channel: a.channel,
      size: { width: a.canvas_width, height: a.canvas_height },
      bannerbearTemplateUid: a.internal_template_id,
      copy: {
        headline: getText(a.manifest.elements, "headline"),
        subheadline: getText(a.manifest.elements, "subheadline"),
        cta: getText(a.manifest.elements, "cta"),
        disclaimer: getText(a.manifest.elements, "legal-disclaimer"),
      },
      composite_metadata: {
        desired_context: a.visual_selection_metadata.desired_context,
        selected_context: a.visual_selection_metadata.selected_context,
        intended_device_type: a.visual_selection_metadata.intended_device_type,
        fallback_used: a.visual_selection_metadata.fallback_used,
        fallback_kind: a.visual_selection_metadata.fallback_kind,
        screenshot_context_confidence:
          a.visual_selection_metadata.screenshot_context_confidence,
        mockup_slot_source: a.visual_selection_metadata.mockup_slot_source,
        composite_id: a.visual_selection_metadata.composite_id,
        composite_public_path: a.visual_selection_metadata.composite_public_path,
        mockup_source_path: null,
        mockup_filename: a.visual_selection_metadata.mockup_filename,
        screenshot_source_path: null,
        screenshot_filename: a.visual_selection_metadata.screenshot_filename,
      },
      manifest: a.manifest,
    })),
  );

  const firstConcept = plan.concepts[0];
  return DemoCampaignSchema.parse({
    generated_at: new Date().toISOString(),
    brand_id: plan.brand_id,
    brand_name: plan.campaign_name,
    campaign: {
      id: plan.campaign_id,
      title: plan.campaign_name,
      headline: firstConcept.copy_package.headline,
      subheadline: firstConcept.copy_package.subheadline,
      cta_text: firstConcept.copy_package.cta,
      disclaimer: firstConcept.copy_package.disclaimer,
    },
    asset_selection: {
      brand_logo: null,
      powered_by_ib: null,
      background: null,
      mockup: null,
      platform_screenshot: null,
      background_fill: {
        kind: "gradient" as const,
        css: "linear-gradient(135deg, #00122C 0%, #005D8D 100%)",
        stops: [
          { color: "#00122C", position: 0 },
          { color: "#005D8D", position: 1 },
        ],
        angle_deg: 135,
      },
      midjourney: {
        background_upload_id: null,
        decorative_upload_ids: [],
        hero_upload_id: null,
      },
    },
    ad_specs,
    warnings: plan.warnings,
  });
}

function getText(elements: Element[], role: string): string {
  const el = elements.find((e) => e.role === role);
  return el?.text ?? "";
}
