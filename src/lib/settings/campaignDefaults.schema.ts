import { z } from "zod";
import {
  CampaignFormatSchema,
  HeadlineEmphasisStyleSchema,
  type CampaignFormat,
  type HeadlineEmphasisStyle,
} from "@/lib/schemas/campaignBrief.schema";
import { LanguageSchema, type Language } from "@/lib/i18n/language";

export const ALL_CAMPAIGN_FORMATS: CampaignFormat[] = [
  "1200x628",
  "1080x1080",
  "1080x1920",
  "1200x1200",
  "300x250",
  "336x280",
  "960x1200",
  "320x100",
  "320x50",
  "300x1050",
  "300x600",
  "160x600",
  "970x250",
  "728x90",
  "250x250",
];

export type CampaignGoal =
  | "awareness"
  | "consideration"
  | "conversion"
  | "retention";

export const CampaignGoalSchema = z.enum([
  "awareness",
  "consideration",
  "conversion",
  "retention",
]);

export const DEFAULT_CAMPAIGN_PLANNER_DEFAULTS = {
  marketing_message: "Trade global markets with confidence",
  campaign_goal: "consideration" as CampaignGoal,
  tone: ["confident", "trustworthy", "premium"],
  required_formats: ALL_CAMPAIGN_FORMATS,
  risk_warning_required: true,
  output_languages: ["en"] as Language[],
  auto_render: true,
  set_active: true,
  creative_mode: "standard" as "standard" | "exploratory",
  headline_emphasis_style: "auto" as HeadlineEmphasisStyle,
  max_diversity: true,
};

export const CampaignPlannerDefaultsSchema = z.object({
  marketing_message: z.string().min(1).default(DEFAULT_CAMPAIGN_PLANNER_DEFAULTS.marketing_message),
  campaign_goal: CampaignGoalSchema.default(DEFAULT_CAMPAIGN_PLANNER_DEFAULTS.campaign_goal),
  tone: z.array(z.string().min(1)).min(1).default(DEFAULT_CAMPAIGN_PLANNER_DEFAULTS.tone),
  required_formats: z
    .array(CampaignFormatSchema)
    .min(1)
    .default(DEFAULT_CAMPAIGN_PLANNER_DEFAULTS.required_formats),
  risk_warning_required: z.boolean().default(DEFAULT_CAMPAIGN_PLANNER_DEFAULTS.risk_warning_required),
  output_languages: z
    .array(LanguageSchema)
    .min(1)
    .default(DEFAULT_CAMPAIGN_PLANNER_DEFAULTS.output_languages),
  auto_render: z.boolean().default(DEFAULT_CAMPAIGN_PLANNER_DEFAULTS.auto_render),
  set_active: z.boolean().default(DEFAULT_CAMPAIGN_PLANNER_DEFAULTS.set_active),
  creative_mode: z
    .enum(["standard", "exploratory"])
    .default(DEFAULT_CAMPAIGN_PLANNER_DEFAULTS.creative_mode),
  headline_emphasis_style: HeadlineEmphasisStyleSchema.default(
    DEFAULT_CAMPAIGN_PLANNER_DEFAULTS.headline_emphasis_style,
  ),
  max_diversity: z.boolean().default(DEFAULT_CAMPAIGN_PLANNER_DEFAULTS.max_diversity),
});

export type CampaignPlannerDefaults = z.infer<typeof CampaignPlannerDefaultsSchema>;

export const CampaignDefaultsSchema = z.object({
  schema_version: z.string().default("1.0.0"),
  campaign_planner: CampaignPlannerDefaultsSchema.default(DEFAULT_CAMPAIGN_PLANNER_DEFAULTS),
});

export type CampaignDefaults = z.infer<typeof CampaignDefaultsSchema>;

export const DEFAULT_CAMPAIGN_DEFAULTS: CampaignDefaults = {
  schema_version: "1.0.0",
  campaign_planner: DEFAULT_CAMPAIGN_PLANNER_DEFAULTS,
};
