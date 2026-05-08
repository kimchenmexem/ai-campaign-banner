import { promises as fs } from "node:fs";
import path from "node:path";
import type { BrandKitLite } from "@/lib/generators/types";

// Loads the slice of brand-kit-lite that the generators consume. We don't
// import the full BrandKitLiteSchema here on purpose — the generators only
// need a handful of fields, and this keeps the surface area tight.

export async function loadBrandKit(cwd: string = process.cwd()): Promise<BrandKitLite> {
  const p = path.join(cwd, "data", "brand-kit-lite.generated.json");
  const raw = await fs.readFile(p, "utf8");
  const json = JSON.parse(raw) as BrandKitLite;
  return json;
}
