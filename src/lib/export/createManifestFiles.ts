import type { CampaignRecord } from "@/lib/schemas/campaign.schema";
import type { ElementManifest } from "@/lib/schemas/elementManifest.schema";
import type { QaReport } from "@/lib/schemas/qaReport.schema";
import type { ExportPackageManifest } from "@/lib/schemas/export.schema";

export interface ExportInputs {
  campaign: CampaignRecord;
  manifests: ElementManifest[];
  qaReports: QaReport[];
}

export interface ManifestFile {
  path: string;
  contents: string;
}

export function buildPackageManifest(_inputs: ExportInputs): ExportPackageManifest {
  throw new Error("buildPackageManifest: not implemented");
}

export function serializeManifestFiles(_inputs: ExportInputs): ManifestFile[] {
  throw new Error("serializeManifestFiles: not implemented");
}
