import {
  QaReportSchema,
  type QaCheckResult,
  type QaReport,
} from "@/lib/schemas/qaReport.schema";
import type { ElementManifest } from "@/lib/schemas/elementManifest.schema";
import type { AdSpec } from "@/lib/schemas/adSpec.schema";

export interface QaInput {
  campaignId: string;
  spec: AdSpec;
  manifest: ElementManifest;
}

export function runDeterministicQa(_input: QaInput): QaReport {
  const checks: QaCheckResult[] = [];
  const summary = {
    passed: checks.filter((c) => c.passed).length,
    failed: checks.filter((c) => !c.passed && c.severity === "error").length,
    warnings: checks.filter((c) => !c.passed && c.severity === "warn").length,
  };
  const report: QaReport = {
    reportId: `qa_${Date.now()}`,
    campaignId: _input.campaignId,
    specId: _input.spec.specId,
    manifestId: _input.manifest.manifestId,
    generatedAt: new Date().toISOString(),
    checks,
    summary,
  };
  return QaReportSchema.parse(report);
}
