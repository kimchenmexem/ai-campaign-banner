"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import type { CampaignIndexEntry } from "@/lib/schemas/aiCampaignPlan.schema";

// Reusable campaign chooser used by /visual-preview and /code-render-preview.
// On change, navigates to the same page with `?campaign=<id>` (or removes the
// param when the operator picks the "Active campaign" sentinel).
//
// Server pages read `searchParams.campaign` and load that id's plan; if it
// fails or is missing, they fall back to the active campaign → static demo
// in that order.

export function CampaignPicker({
  campaigns,
  selectedId,
  activeId,
  basePath,
}: {
  campaigns: CampaignIndexEntry[];
  // The id currently being shown — null when the page is on the active or
  // demo fallback path.
  selectedId: string | null;
  // The campaign tagged as "active" in the index. Used to mark it in the list.
  activeId: string | null;
  // Page path the picker lives on (e.g. "/visual-preview").
  basePath: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value;
    const url = value === "__active__" ? basePath : `${basePath}?campaign=${value}`;
    startTransition(() => {
      router.push(url);
    });
  };

  // Newest first — index file lists them in insert order, but operators want
  // the latest at the top.
  const sorted = [...campaigns].sort((a, b) =>
    a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0,
  );

  const valueAttr = selectedId ?? "__active__";

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <label
        htmlFor="campaign-picker"
        className="font-medium text-zinc-700 dark:text-zinc-300"
      >
        Campaign
      </label>
      <select
        id="campaign-picker"
        value={valueAttr}
        onChange={handleChange}
        disabled={isPending}
        className="rounded border border-zinc-300 bg-white px-2 py-1 text-sm font-mono dark:border-zinc-700 dark:bg-zinc-950"
      >
        <option value="__active__">
          ← Active{activeId ? ` (${activeId})` : " — none"}
        </option>
        {sorted.map((c) => {
          const tags: string[] = [];
          if (c.campaign_id === activeId) tags.push("active");
          if (c.rendered) tags.push("rendered");
          const suffix = tags.length > 0 ? ` · ${tags.join(", ")}` : "";
          return (
            <option key={c.campaign_id} value={c.campaign_id}>
              {c.campaign_id} — {c.campaign_name}
              {suffix}
            </option>
          );
        })}
      </select>
      {sorted.length === 0 && (
        <span className="text-xs text-zinc-500">no campaigns yet</span>
      )}
      {isPending && <span className="text-xs text-zinc-500">loading…</span>}
    </div>
  );
}
