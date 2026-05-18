import { promises as fs } from "node:fs";
import { NextResponse } from "next/server";
import {
  createPromptPack,
  PROMPT_PACK_PATH,
} from "@/lib/midjourney/createPromptPack";
import { MidjourneyPromptPackSchema } from "@/lib/schemas/midjourney.schema";
import { refuseInProduction, requireRole } from "@/lib/auth/guard";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/auth/rateLimit";

// /api/midjourney/prompts
//   GET  → return the current prompt pack (or 404 if not generated yet)
//   POST → regenerate the prompt pack and return it

export async function GET(request: Request) {
  const auth = await requireRole(request, "viewer");
  if (auth instanceof NextResponse) return auth;
  try {
    const raw = await fs.readFile(PROMPT_PACK_PATH, "utf8");
    const pack = MidjourneyPromptPackSchema.parse(JSON.parse(raw));
    return NextResponse.json({ ok: true, pack });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return NextResponse.json(
        {
          ok: false,
          error: "no_pack",
          hint: "Run `npm run midjourney:prompts` to generate the prompt pack.",
        },
        { status: 404 },
      );
    }
    return NextResponse.json(
      { ok: false, error: "read_failed", message: (err as Error).message },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  const blocked = refuseInProduction();
  if (blocked) return blocked;
  const auth = await requireRole(request, "editor");
  if (auth instanceof NextResponse) return auth;
  const limited = enforceRateLimit(request, RATE_LIMITS.write, auth);
  if (limited) return limited;

  const { pack, outputPath } = await createPromptPack();
  return NextResponse.json({
    ok: true,
    pack,
    output_path: outputPath,
  });
}
