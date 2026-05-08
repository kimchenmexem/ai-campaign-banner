"use client";

import { useState } from "react";

// Tiny client island used by the (otherwise server-rendered) campaign detail
// page so operators can one-click-copy a Midjourney prompt while running it.
// Pairs with an external "open Midjourney" link in the surrounding markup.

export function CopyPromptButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // Clipboard API can fail in non-secure contexts; the operator can
          // always select-all in the <pre>.
        }
      }}
      className="rounded-md border border-zinc-300 px-2 py-1 text-[11px] hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
    >
      {copied ? "Copied ✓" : "Copy prompt"}
    </button>
  );
}
