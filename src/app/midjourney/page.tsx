import { promises as fs } from "node:fs";
import path from "node:path";
import {
  MidjourneyPromptPackSchema,
  type MidjourneyPromptPack,
} from "@/lib/schemas/midjourney.schema";
import { loadMidjourneyUploads } from "@/lib/midjourney/loadUploads";
import { loadMidjourneyAssignments } from "@/lib/midjourney/loadAssignments";
import { PromptCard } from "@/components/midjourney/PromptCard";
import { UploadManager } from "@/components/midjourney/UploadManager";

// /midjourney
//
// Manual workflow surface:
//   1. Generate prompt pack via `npm run midjourney:prompts` (or POST below).
//   2. Pick a prompt, copy it, paste it into Midjourney, run it.
//   3. Download the result, upload it through the form here.
//   4. Approve. Re-run `npm run preview:demo` to use it in the demo.
//
// The system never calls Midjourney. Do not use any unofficial Midjourney API.

export const dynamic = "force-dynamic";

const PACK_PATH = path.join(
  process.cwd(),
  "data",
  "midjourney-prompt-pack.generated.json",
);

async function loadPackOrNull(): Promise<MidjourneyPromptPack | null> {
  try {
    const raw = await fs.readFile(PACK_PATH, "utf8");
    return MidjourneyPromptPackSchema.parse(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export default async function MidjourneyPage() {
  const [pack, uploadsFile, assignmentsFile] = await Promise.all([
    loadPackOrNull(),
    loadMidjourneyUploads(),
    loadMidjourneyAssignments(),
  ]);

  return (
    <section className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Midjourney</h1>
        <p className="max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">
          Manual workflow. The system generates prompt packs; the human runs them in
          Midjourney, then uploads selected outputs back here. The Element Manifest
          stays the source of truth — approved uploads become regular image elements
          with a <code>midjourney</code> provenance block.
        </p>
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
          <p className="font-medium">Forbidden in Midjourney</p>
          <ul className="mt-1 list-disc list-inside">
            <li>Brand logo, IBKR / Powered by IB logo</li>
            <li>CTA copy, disclaimer, risk warning, any required marketing copy</li>
            <li>Readable UI text, fake app screenshots</li>
          </ul>
          <p className="mt-2">
            Midjourney is allowed only as background, hero visual, decorative, moodboard,
            or texture inputs. Do not use any unofficial Midjourney API.
          </p>
        </div>
      </header>

      {!pack ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
          <p className="font-medium">No prompt pack found.</p>
          <p className="mt-1">
            Run <code>npm run midjourney:prompts</code> (or POST{" "}
            <code>/api/midjourney/prompts</code>) to generate the pack, then refresh.
          </p>
        </div>
      ) : (
        <>
          <section className="space-y-3">
            <header className="flex items-baseline justify-between">
              <h2 className="text-lg font-medium">
                Prompts ({pack.prompts.length})
              </h2>
              <span className="text-xs text-zinc-500">
                pack: {pack.pack_id} · brand: {pack.brand_id}
              </span>
            </header>
            <ol className="space-y-3 list-decimal list-inside text-xs text-zinc-600 dark:text-zinc-400">
              <li>Copy a prompt below.</li>
              <li>Run it manually in Midjourney.</li>
              <li>Download the selected result.</li>
              <li>Upload it in the form below.</li>
              <li>Approve the upload.</li>
              <li>
                Run <code>npm run preview:demo</code> to use it in the demo manifest.
              </li>
            </ol>
            <ul className="space-y-3">
              {pack.prompts.map((p) => (
                <PromptCard key={p.prompt_id} prompt={p} />
              ))}
            </ul>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-medium">Uploads</h2>
            <UploadManager
              prompts={pack.prompts}
              initialUploads={uploadsFile.uploads}
              initialAssignments={assignmentsFile.assignments}
            />
          </section>
        </>
      )}
    </section>
  );
}
