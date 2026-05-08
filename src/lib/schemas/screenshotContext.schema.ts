import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Screenshot context — leaf schema with no node:fs / node:path imports, so it
// is safe to import from client components and from other schemas.
//
// The full inference machinery lives in src/lib/preview/inferScreenshotContext.ts
// and re-exports these symbols for back-compat.
// ─────────────────────────────────────────────────────────────────────────────

export const ScreenshotContextSchema = z.enum([
  "stocks",
  "etfs",
  "charts",
  "green_data",
  "general_platform",
]);
export type ScreenshotContext = z.infer<typeof ScreenshotContextSchema>;

export const SCREENSHOT_CONTEXTS: ScreenshotContext[] = [
  "stocks",
  "etfs",
  "charts",
  "green_data",
  "general_platform",
];
