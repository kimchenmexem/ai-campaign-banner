import JSZip from "jszip";
import type { ExportInputs } from "@/lib/export/createManifestFiles";

export interface CampaignZipResult {
  buffer: Uint8Array;
  filename: string;
}

export async function createCampaignZip(inputs: ExportInputs): Promise<CampaignZipResult> {
  const zip = new JSZip();
  zip.folder("finals");
  zip.folder("elements");
  zip.folder("copy");
  zip.folder("specs");
  zip.folder("qa");
  zip.file("README.txt", `Campaign export ${inputs.campaign.id} (placeholder).`);
  const buffer = await zip.generateAsync({ type: "uint8array" });
  return { buffer, filename: `campaign-${inputs.campaign.id}.zip` };
}
