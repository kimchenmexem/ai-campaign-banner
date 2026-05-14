"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

interface Props {
  folderTypes: string[];
}

const FOLDER_DISPLAY_NAME: Record<string, string> = {
  brand_logo: "Brand logos",
  powered_by_ib: "Powered by IB",
  mockups: "Mockups",
  platform_screenshots: "Platform screenshots",
  elements: "Decorative elements",
  backgrounds: "Backgrounds",
};

export function AssetUploader({ folderTypes }: Props) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [folder, setFolder] = useState<string>(folderTypes[0] ?? "elements");
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<
    | { kind: "idle" }
    | { kind: "uploading" }
    | { kind: "ok"; filename: string }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  const [, startTransition] = useTransition();

  function clearFile() {
    setFile(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  async function upload() {
    if (!file) return;
    setStatus({ kind: "uploading" });
    const fd = new FormData();
    fd.append("file", file);
    fd.append("canonical_folder_type", folder);

    startTransition(async () => {
      try {
        const res = await fetch("/api/upload-asset", { method: "POST", body: fd });
        const j = (await res.json()) as
          | { ok: true; item: { filename: string; public_path: string } }
          | { ok: false; error: string; message?: string };
        if (!res.ok || !j.ok) {
          const err = j as { error: string; message?: string };
          setStatus({ kind: "error", message: err.message ?? err.error ?? `HTTP ${res.status}` });
          return;
        }
        setStatus({ kind: "ok", filename: j.item.filename });
        clearFile();
        // Refresh the server component so the new asset appears in the grid.
        router.refresh();
      } catch (err) {
        setStatus({ kind: "error", message: (err as Error).message });
      }
    });
  }

  return (
    <section className="rounded-md border border-zinc-200 dark:border-zinc-800 p-4 space-y-3 bg-zinc-50 dark:bg-zinc-900/50">
      <h2 className="text-sm font-semibold">Add an asset</h2>
      <p className="text-xs text-zinc-500">
        Allowed: PNG / JPG / WEBP / SVG, up to 10&nbsp;MB. Uploads write into
        <code className="font-mono text-[11px] mx-1">
          public/brand-input-preview/&lt;type&gt;/&lt;filename&gt;
        </code>
        and add an entry to{" "}
        <code className="font-mono text-[11px]">data/asset-preview-map.generated.json</code>.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-xs text-zinc-500">
          Category
          <select
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            className="ml-2 rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1 text-sm"
          >
            {folderTypes.map((f) => (
              <option key={f} value={f}>
                {FOLDER_DISPLAY_NAME[f] ?? f} ({f})
              </option>
            ))}
          </select>
        </label>
        <input
          ref={inputRef}
          type="file"
          accept=".png,.jpg,.jpeg,.webp,.svg"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="text-sm"
        />
        <button
          type="button"
          onClick={upload}
          disabled={!file || status.kind === "uploading"}
          className="rounded bg-blue-600 px-4 py-1 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
        >
          {status.kind === "uploading" ? "Uploading…" : "Upload"}
        </button>
        {file && status.kind !== "uploading" && (
          <button
            type="button"
            onClick={clearFile}
            className="rounded border border-zinc-300 dark:border-zinc-700 px-3 py-1 text-xs"
          >
            Clear
          </button>
        )}
      </div>
      {status.kind === "ok" && (
        <div className="text-sm text-emerald-700 dark:text-emerald-400">
          ✓ Uploaded <code className="font-mono text-xs">{status.filename}</code>. Grid below has refreshed.
        </div>
      )}
      {status.kind === "error" && (
        <div className="text-sm text-red-700 dark:text-red-400">✗ {status.message}</div>
      )}
    </section>
  );
}
