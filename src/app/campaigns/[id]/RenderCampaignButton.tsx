"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

// Client island for the "Render now" CTA on /campaigns/[id]. POSTs to
// /api/render-campaign and reloads the page so the new PNGs show up.
// Render takes ~20-40s for 9 ads.
//
// UX signals operators rely on to know rendering finished:
//   1. While in flight: button shows "Rendering… 12s" with a live elapsed
//      timer (updates each second). The button stays disabled.
//   2. On success: button flips back to "Re-render PNGs", AND a green
//      success banner appears reading "✓ Rendered 9/9 banners in 28s"
//      that stays visible until the next click. The page also refreshes
//      so the new PNGs show under each ad.
//   3. On failure: red error banner with the reason; button is clickable
//      again so the operator can retry.

interface SuccessSummary {
  total: number;
  completed: number;
  failed: number;
  elapsedSec: number;
}

export function RenderCampaignButton({
  campaignId,
  alreadyRendered,
}: {
  campaignId: string;
  alreadyRendered: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<SuccessSummary | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const startedAtRef = useRef<number | null>(null);

  // Tick a 1-second timer while the request is pending so the operator
  // sees forward progress. Cleared as soon as the request settles.
  useEffect(() => {
    if (!pending) {
      setElapsedSec(0);
      startedAtRef.current = null;
      return;
    }
    startedAtRef.current = Date.now();
    const t = setInterval(() => {
      if (startedAtRef.current !== null) {
        setElapsedSec(Math.round((Date.now() - startedAtRef.current) / 1000));
      }
    }, 1000);
    return () => clearInterval(t);
  }, [pending]);

  async function onClick() {
    setError(null);
    setSuccess(null);
    setPending(true);
    const t0 = Date.now();
    try {
      const res = await fetch("/api/render-campaign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaign_id: campaignId }),
      });
      const json = (await res.json()) as
        | { ok: true; total: number; completed: number; failed: number }
        | { ok: false; error: string; message?: string };
      if (!res.ok || !json.ok) {
        const j = json as { error: string; message?: string };
        setError(j.message ?? j.error ?? `HTTP ${res.status}`);
        return;
      }
      setSuccess({
        total: json.total,
        completed: json.completed,
        failed: json.failed,
        elapsedSec: Math.round((Date.now() - t0) / 1000),
      });
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(false);
    }
  }

  const label = pending
    ? `Rendering… ${elapsedSec}s`
    : alreadyRendered
      ? "Re-render PNGs"
      : "Render PNGs now";

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        aria-busy={pending}
        className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
          alreadyRendered
            ? "border border-zinc-300 bg-white text-zinc-900 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:hover:bg-zinc-900"
            : "bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        } disabled:opacity-60`}
      >
        {label}
      </button>
      {pending && (
        <div className="text-xs text-zinc-500 dark:text-zinc-400">
          Working — typically 20–40s for 9 ads. The page will refresh
          automatically when it finishes.
        </div>
      )}
      {success && !pending && (
        <div className="rounded-md border border-emerald-300 bg-emerald-50 p-2 text-xs text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-200">
          ✓ Rendered {success.completed}/{success.total} banners in {success.elapsedSec}s
          {success.failed > 0 ? ` (${success.failed} failed)` : ""}.
        </div>
      )}
      {error && (
        <div className="rounded-md border border-rose-300 bg-rose-50 p-2 text-xs text-rose-900 dark:border-rose-700 dark:bg-rose-950/40 dark:text-rose-200">
          {error}
        </div>
      )}
    </div>
  );
}
