"use client";
import { useState } from "react";
import type { ElementManifest } from "@/lib/schemas/elementManifest.schema";

// ManifestViewer — collapsible JSON view of the Element Manifest.
// Client component because of the open/closed state.

export interface ManifestViewerProps {
  manifest: ElementManifest;
  initiallyOpen?: boolean;
}

export function ManifestViewer({ manifest, initiallyOpen = false }: ManifestViewerProps) {
  const [open, setOpen] = useState(initiallyOpen);
  const json = JSON.stringify(manifest, null, 2);

  return (
    <div className="rounded-md border border-zinc-200 dark:border-zinc-800">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 text-left text-sm font-medium hover:bg-zinc-50 dark:hover:bg-zinc-900"
      >
        <span>
          Element Manifest ({manifest.elements.length} elements,{" "}
          {manifest.size.width}×{manifest.size.height})
        </span>
        <span className="text-xs text-zinc-500">{open ? "hide" : "show"}</span>
      </button>
      {open && (
        <pre className="max-h-96 overflow-auto px-3 py-2 text-xs leading-snug bg-zinc-50 dark:bg-zinc-950 dark:text-zinc-200">
          {json}
        </pre>
      )}
    </div>
  );
}
