"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { AssetPreviewRecord } from "@/lib/preview/copyPreviewAssets";

interface Props {
  item: AssetPreviewRecord;
}

export function AssetCard({ item }: Props) {
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  async function remove() {
    const ok = window.confirm(
      `Remove ${item.original_filename} from the asset map and delete the file?\n\nThis can't be undone from the UI — but the source file in brand-input/ stays (running npm run preview:assets puts it back).`,
    );
    if (!ok) return;
    setDeleting(true);
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/asset", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ public_path: item.public_path }),
        });
        const j = (await res.json()) as
          | { ok: true; file_deleted: boolean }
          | { ok: false; error: string; message?: string };
        if (!res.ok || !j.ok) {
          const err = j as { error: string; message?: string };
          setError(err.message ?? err.error);
          setDeleting(false);
          return;
        }
        // Server-component refresh — the asset disappears from the grid.
        router.refresh();
      } catch (err) {
        setError((err as Error).message);
        setDeleting(false);
      }
    });
  }

  return (
    <div
      className={`relative block rounded border border-zinc-200 dark:border-zinc-800 p-2 transition ${
        deleting ? "opacity-50" : "hover:border-blue-400"
      }`}
    >
      <button
        type="button"
        onClick={remove}
        disabled={deleting}
        aria-label="remove asset"
        title="Remove asset"
        className="absolute top-1 right-1 z-10 h-6 w-6 rounded-full bg-white/90 dark:bg-zinc-900/90 border border-zinc-300 dark:border-zinc-700 text-xs text-zinc-700 dark:text-zinc-200 hover:bg-red-500 hover:text-white hover:border-red-500 transition flex items-center justify-center"
      >
        {deleting ? "…" : "×"}
      </button>
      <a
        href={item.public_path}
        target="_blank"
        rel="noreferrer"
        className="block"
      >
        <div className="aspect-square bg-zinc-100 dark:bg-zinc-900 rounded flex items-center justify-center overflow-hidden">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={item.public_path}
            alt={item.original_filename}
            className="max-w-full max-h-full object-contain"
            loading="lazy"
          />
        </div>
        <div
          className="mt-2 text-xs font-mono truncate text-zinc-700 dark:text-zinc-300"
          title={item.original_filename}
        >
          {item.original_filename}
        </div>
        <div className="text-xs text-zinc-500">{item.asset_type}</div>
      </a>
      {error && (
        <div className="mt-1 text-xs text-amber-700 dark:text-amber-400">{error}</div>
      )}
    </div>
  );
}
