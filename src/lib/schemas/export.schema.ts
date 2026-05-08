import { z } from "zod";

export const ExportPackageManifestSchema = z.object({
  campaignId: z.string().min(1),
  generatedAt: z.string(),
  contents: z.object({
    finals: z.array(z.string()).default([]),
    elements: z.array(z.string()).default([]),
    copy: z.array(z.string()).default([]),
    specs: z.array(z.string()).default([]),
    qa: z.array(z.string()).default([]),
  }),
  notes: z.string().optional(),
});
export type ExportPackageManifest = z.infer<typeof ExportPackageManifestSchema>;
