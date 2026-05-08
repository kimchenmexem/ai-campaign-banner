"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

// Client island for the "Run Vision QA" CTA on /campaigns/[id]. POSTs to
// /api/qa-campaign and reloads the page so the new violations block shows up.
// QA takes ~5-15s per banner with Gemini Flash (free tier, 15 RPM cap).

export function RunQaButton({
  campaignId,
  alreadyRan,
  canRun,
}: {
  campaignId: string;
  alreadyRan: boolean;
  canRun: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    setError(null);
    setPending(true);
    try {
      const res = await fetch("/api/qa-campaign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaign_id: campaignId }),
      });
      const json = (await res.json()) as
        | { ok: true; map: { with_violations: number; total: number } }
        | { ok: false; error: string; message?: string };
      if (!res.ok || !json.ok) {
        const j = json as { error: string; message?: string };
        setError(j.message ?? j.error ?? `HTTP ${res.status}`);
        return;
      }
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={onClick}
        disabled={pending || !canRun}
        className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        title={
          !canRun
            ? "Render the campaign first — QA needs the rendered PNGs."
            : alreadyRan
              ? "Re-run Vision QA over the latest renders"
              : "Run Gemini Vision QA over every rendered banner"
        }
      >
        {pending
          ? "Running QA…"
          : alreadyRan
            ? "↻ Re-run QA"
            : "▶ Run Vision QA"}
      </button>
      {error && (
        <p className="rounded border border-red-300 bg-red-50 p-1 text-xs text-red-900 dark:border-red-700 dark:bg-red-950/40 dark:text-red-200">
          {error}
        </p>
      )}
    </div>
  );
}
