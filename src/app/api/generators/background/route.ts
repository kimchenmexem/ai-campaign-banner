import { generateBackground } from "@/lib/generators/background/generateBackground";
import { runGenerator } from "@/lib/generators/runGenerator";

// POST /api/generators/background
// Body: BackgroundParams (see src/lib/schemas/generatedAsset.schema.ts)
// Returns: { ok: true, asset: GeneratedAsset } | { ok: false, error, ... }

export async function POST(request: Request) {
  return runGenerator(request, generateBackground);
}
