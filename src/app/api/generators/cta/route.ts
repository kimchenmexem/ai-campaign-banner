import { generateCta } from "@/lib/generators/cta/generateCta";
import { runGenerator } from "@/lib/generators/runGenerator";

// POST /api/generators/cta
// Body: CtaParams
export async function POST(request: Request) {
  return runGenerator(request, generateCta);
}
