"use client";
import { useMemo, useState } from "react";
import type { AssetPreviewRecord } from "@/lib/preview/copyPreviewAssets";
import type {
  ScreenshotContext,
  ScreenshotContextConfidence,
  ScreenshotTag,
} from "@/lib/preview/inferScreenshotContext";

const CONTEXTS: ScreenshotContext[] = [
  "stocks",
  "etfs",
  "charts",
  "green_data",
  "general_platform",
];

export interface ScreenshotTagEditorProps {
  screenshots: Array<{
    record: AssetPreviewRecord;
    inferred_context: ScreenshotContext;
    inferred_confidence: ScreenshotContextConfidence;
  }>;
  initialTags: ScreenshotTag[];
}

interface RowState {
  context: ScreenshotContext | "";
  notes: string;
  inferred_context: ScreenshotContext;
  inferred_confidence: ScreenshotContextConfidence;
}

export function ScreenshotTagEditor({
  screenshots,
  initialTags,
}: ScreenshotTagEditorProps) {
  const initialMap = useMemo(() => {
    const map = new Map<string, ScreenshotTag>();
    for (const t of initialTags) map.set(t.filename.toLowerCase(), t);
    return map;
  }, [initialTags]);

  const [rows, setRows] = useState<Record<string, RowState>>(() => {
    const out: Record<string, RowState> = {};
    for (const s of screenshots) {
      const key = s.record.original_filename;
      const existing = initialMap.get(key.toLowerCase());
      out[key] = {
        context: existing?.context ?? "",
        notes: existing?.notes ?? "",
        inferred_context: s.inferred_context,
        inferred_confidence: s.inferred_confidence,
      };
    }
    return out;
  });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  function update(filename: string, patch: Partial<RowState>) {
    setRows((prev) => ({ ...prev, [filename]: { ...prev[filename], ...patch } }));
  }

  async function save() {
    setSaving(true);
    setMessage(null);
    const tags: ScreenshotTag[] = Object.entries(rows)
      .filter(([, v]) => v.context !== "")
      .map(([filename, v]) => ({
        filename,
        context: v.context as ScreenshotContext,
        ...(v.notes.trim() ? { notes: v.notes.trim() } : {}),
      }));
    try {
      const res = await fetch("/api/screenshot-tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setMessage(`Save failed: ${data.error ?? res.statusText}`);
      } else {
        setMessage(`Saved ${data.count} tags. Run \`npm run preview:mockups && npm run preview:demo\` to regenerate composites.`);
      }
    } catch (err) {
      setMessage(`Save failed: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  const taggedCount = Object.values(rows).filter((r) => r.context !== "").length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4 rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm dark:border-zinc-800 dark:bg-zinc-900">
        <div>
          <span className="font-medium">{taggedCount}</span> of{" "}
          <span className="font-medium">{screenshots.length}</span> screenshots tagged.
        </div>
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="rounded-md bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
        >
          {saving ? "Saving…" : "Save all tags"}
        </button>
      </div>
      {message && (
        <div className="rounded-md border border-emerald-300 bg-emerald-50 p-2 text-xs text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100">
          {message}
        </div>
      )}

      <ul className="grid gap-3 md:grid-cols-2">
        {screenshots.map(({ record }) => {
          const filename = record.original_filename;
          const row = rows[filename];
          return (
            <li
              key={record.public_path}
              className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800"
            >
              <div className="grid grid-cols-[120px_1fr] gap-3">
                <div className="flex h-[120px] w-[120px] items-center justify-center overflow-hidden rounded bg-zinc-100 dark:bg-zinc-900">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={record.public_path}
                    alt={filename}
                    className="h-full w-full object-contain"
                  />
                </div>
                <div className="min-w-0 space-y-2">
                  <div className="truncate text-sm font-medium" title={filename}>
                    {filename}
                  </div>
                  <div className="flex flex-wrap gap-2 text-[11px]">
                    <span className="rounded bg-zinc-100 px-1.5 py-0.5 dark:bg-zinc-800">
                      inferred: {row.inferred_context}
                    </span>
                    <span className="rounded bg-zinc-100 px-1.5 py-0.5 dark:bg-zinc-800">
                      confidence: {row.inferred_confidence}
                    </span>
                  </div>
                  <select
                    value={row.context}
                    onChange={(e) =>
                      update(filename, {
                        context: e.target.value as ScreenshotContext | "",
                      })
                    }
                    className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-950"
                  >
                    <option value="">— no explicit tag —</option>
                    {CONTEXTS.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    value={row.notes}
                    onChange={(e) => update(filename, { notes: e.target.value })}
                    placeholder="Optional notes (e.g. 'Stocks watchlist screen')"
                    className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-950"
                  />
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
