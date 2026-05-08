"use client";
import { useState } from "react";
import type { MidjourneyPrompt } from "@/lib/schemas/midjourney.schema";

const TONE_BY_USE: Record<string, string> = {
  background: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200",
  hero_visual: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  decorative: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  moodboard: "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200",
  texture: "bg-zinc-100 text-zinc-800 dark:bg-zinc-900 dark:text-zinc-300",
};

export function PromptCard({ prompt }: { prompt: MidjourneyPrompt }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(prompt.prompt_text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <li className="rounded-md border border-zinc-200 p-4 dark:border-zinc-800">
      <header className="mb-2 flex flex-wrap items-baseline gap-2">
        <h3 className="text-sm font-medium">{prompt.title}</h3>
        <span
          className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
            TONE_BY_USE[prompt.intended_use] ?? TONE_BY_USE.texture
          }`}
        >
          {prompt.intended_use}
        </span>
        <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] dark:bg-zinc-900">
          context: {prompt.context}
        </span>
        <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] dark:bg-zinc-900">
          --ar {prompt.aspect_ratio}
        </span>
        <span className="ml-auto text-[11px] text-zinc-500">{prompt.prompt_id}</span>
      </header>

      <pre className="whitespace-pre-wrap break-words rounded bg-zinc-50 p-3 text-xs leading-relaxed dark:bg-zinc-900">
        {prompt.prompt_text}
      </pre>

      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={copy}
          className="rounded-md bg-zinc-900 px-3 py-1 text-xs font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900"
        >
          {copied ? "Copied ✓" : "Copy prompt"}
        </button>
        {prompt.notes && (
          <span className="text-[11px] italic text-zinc-500">{prompt.notes}</span>
        )}
      </div>

      {prompt.forbidden_outputs.length > 0 && (
        <div className="mt-3 rounded border border-amber-300 bg-amber-50 p-2 text-[11px] text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
          <div className="font-medium">Do not generate</div>
          <ul className="mt-0.5 list-disc list-inside">
            {prompt.forbidden_outputs.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </div>
      )}

      {prompt.recommended_references.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 text-[11px] font-medium text-zinc-600 dark:text-zinc-400">
            Recommended references ({prompt.recommended_references.length}) — drag
            into Midjourney as <em>style references</em> only
          </div>
          <ul className="grid gap-2 grid-cols-[repeat(auto-fill,minmax(140px,1fr))]">
            {prompt.recommended_references.map((ref) => (
              <li
                key={ref.local_path}
                className="rounded border border-zinc-200 p-2 text-[11px] dark:border-zinc-800"
                title={ref.local_path}
              >
                {ref.public_path && (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    src={ref.cloudinary_secure_url ?? ref.public_path}
                    alt={ref.filename}
                    className="mb-1 h-20 w-full rounded bg-zinc-100 object-contain dark:bg-zinc-900"
                  />
                )}
                <div className="truncate font-medium" title={ref.filename}>
                  {ref.filename}
                </div>
                <div className="text-zinc-500">
                  {ref.asset_type} · {ref.midjourney_role.replaceAll("_", " ")}
                </div>
                {ref.why_selected && (
                  <div className="mt-1 italic text-zinc-500">{ref.why_selected}</div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}
