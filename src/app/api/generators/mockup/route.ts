import { generateMockup } from "@/lib/generators/mockup/generateMockup";
import { runGenerator } from "@/lib/generators/runGenerator";

// POST /api/generators/mockup
// Body: MockupParams
export async function POST(request: Request) {
  return runGenerator(request, generateMockup);
}
