import { generateFxOverlay } from "@/lib/generators/fxOverlay/generateFxOverlay";
import { runGenerator } from "@/lib/generators/runGenerator";

// POST /api/generators/fx-overlay
// Body: FxOverlayParams
export async function POST(request: Request) {
  return runGenerator(request, generateFxOverlay);
}
