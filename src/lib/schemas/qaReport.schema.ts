import { z } from "zod";

export const QaSeveritySchema = z.enum(["info", "warn", "error"]);
export type QaSeverity = z.infer<typeof QaSeveritySchema>;

export const QaCheckResultSchema = z.object({
  checkId: z.string().min(1),
  description: z.string().min(1),
  severity: QaSeveritySchema,
  passed: z.boolean(),
  message: z.string().optional(),
});
export type QaCheckResult = z.infer<typeof QaCheckResultSchema>;

export const QaReportSchema = z.object({
  reportId: z.string().min(1),
  campaignId: z.string().min(1),
  specId: z.string().min(1).optional(),
  manifestId: z.string().min(1).optional(),
  generatedAt: z.string(),
  checks: z.array(QaCheckResultSchema),
  summary: z.object({
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    warnings: z.number().int().nonnegative(),
  }),
});
export type QaReport = z.infer<typeof QaReportSchema>;
