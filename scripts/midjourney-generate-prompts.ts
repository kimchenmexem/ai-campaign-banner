#!/usr/bin/env tsx
/**
 * Generate the Midjourney prompt pack and print it in a copy-friendly form.
 * Run with: `npm run midjourney:prompts`
 *
 * Writes data/midjourney-prompt-pack.generated.json. Does NOT call Midjourney.
 * Midjourney is manual: copy a prompt, paste it into Midjourney yourself,
 * download the output, then upload it via /midjourney in the dev server.
 */
import path from "node:path";
import { createPromptPack } from "@/lib/midjourney/createPromptPack";

async function main() {
  const { pack, outputPath } = await createPromptPack();

  console.log("");
  console.log("⚠  Midjourney is manual. The system never calls Midjourney.");
  console.log("⚠  Do not use any unofficial Midjourney API.");
  console.log("⚠  Run prompts manually, then upload selected outputs at /midjourney.");
  console.log("");
  console.log(`✓ Wrote ${path.relative(process.cwd(), outputPath)}`);
  console.log(`  pack_id:     ${pack.pack_id}`);
  console.log(`  brand_id:    ${pack.brand_id}`);
  console.log(`  prompts:     ${pack.prompts.length}`);
  console.log("");

  for (const p of pack.prompts) {
    console.log("─".repeat(72));
    console.log(`# ${p.title}`);
    console.log(`  prompt_id:    ${p.prompt_id}`);
    console.log(`  intended_use: ${p.intended_use}`);
    console.log(`  context:      ${p.context}`);
    console.log(`  aspect_ratio: ${p.aspect_ratio}`);
    console.log("");
    console.log("  PROMPT (copy below this line):");
    console.log("  --------------------------------------------------------");
    console.log(`  ${p.prompt_text}`);
    console.log("  --------------------------------------------------------");
    if (p.notes) {
      console.log(`  notes: ${p.notes}`);
    }
    console.log("");
  }

  console.log("Next:");
  console.log("  1. Copy a prompt above and paste it into Midjourney.");
  console.log("  2. Pick a result, download the PNG/JPG.");
  console.log("  3. Open /midjourney in the dev server.");
  console.log("  4. Upload the file, choose its prompt + intended_use, approve.");
  console.log("  5. Re-run `npm run preview:demo` to use it in the demo manifest.");
}

main().catch((err) => {
  console.error("midjourney:prompts failed:", (err as Error).message);
  process.exit(1);
});
