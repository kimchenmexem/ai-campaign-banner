#!/usr/bin/env tsx
/**
 * Build the Midjourney prompt pack (if missing), build the reference pack,
 * and copy the per-prompt selected references into
 *   public/midjourney-reference-pack/<prompt_id>/
 * so the user can right-click → save (or just drag from the file system) into
 * Midjourney.
 *
 * Run with: `npm run midjourney:reference-pack`
 *
 * Does NOT call Midjourney. Midjourney remains a manual workflow.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { createPromptPack } from "@/lib/midjourney/createPromptPack";
import {
  REFERENCE_PUBLIC_DIR,
  PROMPT_PACK_PATH,
  REFERENCE_PACK_PATH,
  createReferencePack,
  FORBIDDEN_OUTPUTS_LIST,
} from "@/lib/midjourney/createReferencePack";
import {
  MidjourneyPromptPackSchema,
  MidjourneyReferencePackSchema,
  type MidjourneyReferencePack,
} from "@/lib/schemas/midjourney.schema";

async function main() {
  console.log(
    "Midjourney reference-pack export — generating prompt + reference packs locally.",
  );
  console.log("This script does NOT call Midjourney. Manual workflow only.\n");

  // 1. Ensure the prompt pack exists. createPromptPack runs the reference
  //    pass internally; that's fine — we re-run it below to also copy files.
  if (!(await fileExists(PROMPT_PACK_PATH))) {
    console.log("· No prompt pack found. Generating one ...");
    await createPromptPack();
    console.log(`  ✓ Wrote ${path.relative(process.cwd(), PROMPT_PACK_PATH)}`);
  } else {
    console.log("· Prompt pack already exists.");
  }

  // 2. Re-run the reference selector + reference pack write. This is fast
  //    (no network) and ensures the pack stays in sync with the prompt pack.
  const refResult = await createReferencePack();
  console.log(
    `· Wrote ${path.relative(process.cwd(), refResult.outputPath)} (${refResult.pack.prompts.length} prompts)`,
  );

  // 2b. Re-stamp the prompt pack with the per-prompt inline recommendations
  //     so the /midjourney page sees them without re-running createPromptPack.
  await restampPromptPack(refResult.recommendationsByPromptId);

  // 3. Copy each per-prompt selected reference into public/midjourney-reference-pack/<prompt_id>/.
  //    Re-write the reference pack so each entry's local_copy_path /
  //    public_copy_path point to the copied file.
  const cwd = process.cwd();
  const publicRoot = path.join(cwd, "public", REFERENCE_PUBLIC_DIR);
  await fs.mkdir(publicRoot, { recursive: true });

  let totalCopied = 0;
  let totalSkipped = 0;
  for (const prompt of refResult.pack.prompts) {
    const promptDir = path.join(publicRoot, sanitize(prompt.prompt_id));
    await fs.mkdir(promptDir, { recursive: true });
    for (const ref of prompt.selected_reference_assets) {
      const srcAbs = path.resolve(cwd, ref.local_path);
      const filenameSafe = sanitize(ref.filename);
      const destAbs = path.join(promptDir, filenameSafe);
      try {
        await fs.copyFile(srcAbs, destAbs);
        ref.local_copy_path = path.relative(cwd, destAbs);
        ref.public_copy_path = `/${REFERENCE_PUBLIC_DIR}/${sanitize(prompt.prompt_id)}/${filenameSafe}`;
        totalCopied += 1;
      } catch (err) {
        ref.local_copy_path = null;
        ref.public_copy_path = null;
        totalSkipped += 1;
        console.warn(
          `  ! Could not copy ${ref.local_path}: ${(err as Error).message}`,
        );
      }
    }
  }

  // Re-validate + rewrite the pack with copied paths embedded.
  const repacked: MidjourneyReferencePack = MidjourneyReferencePackSchema.parse(
    refResult.pack,
  );
  await fs.writeFile(REFERENCE_PACK_PATH, JSON.stringify(repacked, null, 2) + "\n", "utf8");

  // 4. Summary.
  console.log("");
  console.log("Summary");
  console.log("─".repeat(60));
  console.log(
    `  classifications:    ${repacked.classifications.style_reference.length} style refs · ${repacked.classifications.avoid_for_midjourney.length} avoid`,
  );
  console.log(`  prompts processed:  ${repacked.prompts.length}`);
  console.log(`  reference copies:   ${totalCopied} files`);
  if (totalSkipped > 0) {
    console.log(`  copy failures:      ${totalSkipped}`);
  }
  console.log("");
  console.log(`✓ Wrote ${path.relative(cwd, REFERENCE_PACK_PATH)}`);
  console.log(`✓ Files at public/${REFERENCE_PUBLIC_DIR}/<prompt_id>/`);
  console.log("");
  console.log("Next:");
  console.log("  1. Open /midjourney to see prompts + their recommended references.");
  console.log("  2. Drag the public/midjourney-reference-pack/<prompt_id>/ files into Midjourney");
  console.log("     as style references (--sref) — never as image prompts that should be copied.");
  console.log("  3. Run the prompt manually, download the result, upload it via the form.");
}

async function restampPromptPack(
  recsByPromptId: Map<
    string,
    Awaited<ReturnType<typeof createReferencePack>>["recommendationsByPromptId"] extends Map<
      string,
      infer V
    >
      ? V
      : never
  >,
): Promise<void> {
  const raw = await fs.readFile(PROMPT_PACK_PATH, "utf8");
  const pack = MidjourneyPromptPackSchema.parse(JSON.parse(raw));
  const updated = MidjourneyPromptPackSchema.parse({
    ...pack,
    prompts: pack.prompts.map((p) => ({
      ...p,
      recommended_references: recsByPromptId.get(p.prompt_id) ?? [],
      forbidden_outputs: FORBIDDEN_OUTPUTS_LIST,
    })),
  });
  await fs.writeFile(PROMPT_PACK_PATH, JSON.stringify(updated, null, 2) + "\n", "utf8");
  console.log(
    `· Re-stamped ${path.relative(process.cwd(), PROMPT_PACK_PATH)} with per-prompt references`,
  );
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function sanitize(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "") || "_unsorted"
  );
}

main().catch((err) => {
  console.error("midjourney:reference-pack failed:", (err as Error).message);
  process.exit(1);
});
