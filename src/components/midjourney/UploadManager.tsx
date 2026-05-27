"use client";
import { useEffect, useState } from "react";
import type {
  MidjourneyAspectRatio,
  MidjourneyAssignment,
  MidjourneyAssignmentFormat,
  MidjourneyAssignmentTargetRole,
  MidjourneyContext,
  MidjourneyIntendedUse,
  MidjourneyPrompt,
  MidjourneyUpload,
} from "@/lib/schemas/midjourney.schema";

const INTENDED_USES: MidjourneyIntendedUse[] = [
  "background",
  "hero_visual",
  "decorative",
  "moodboard",
  "texture",
];

const CONTEXTS: MidjourneyContext[] = [
  "stocks",
  "etfs",
  "charts",
  "green_data",
  "general_platform",
  "premium_fintech",
];

export interface UploadManagerProps {
  prompts: MidjourneyPrompt[];
  initialUploads: MidjourneyUpload[];
  initialAssignments: MidjourneyAssignment[];
}

const ASSIGNMENT_TARGETS: {
  format: MidjourneyAssignmentFormat;
  target: MidjourneyAssignmentTargetRole;
  label: string;
}[] = [
  { format: null, target: "background", label: "Background — all formats" },
  { format: "1200x628", target: "background", label: "Background — 1200×628" },
  { format: "1080x1080", target: "background", label: "Background — 1080×1080" },
  { format: "1080x1920", target: "background", label: "Background — 1080×1920" },
  { format: null, target: "decorative_1", label: "Decorative_1 — all formats" },
  { format: null, target: "decorative_2", label: "Decorative_2 — all formats" },
  { format: null, target: "hero_visual", label: "Hero — all formats" },
];

export function UploadManager({
  prompts,
  initialUploads,
  initialAssignments,
}: UploadManagerProps) {
  const [uploads, setUploads] = useState<MidjourneyUpload[]>(initialUploads);
  const [assignments, setAssignments] =
    useState<MidjourneyAssignment[]>(initialAssignments);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Form state
  const [file, setFile] = useState<File | null>(null);
  const defaultPromptId = prompts[0]?.prompt_id ?? "";
  const [promptId, setPromptId] = useState(defaultPromptId);
  const [intendedUse, setIntendedUse] = useState<MidjourneyIntendedUse>("background");
  const [context, setContext] = useState<MidjourneyContext>("premium_fintech");
  const [aspectRatio, setAspectRatio] = useState<MidjourneyAspectRatio | "">("");
  const [approved, setApproved] = useState(false);
  const [notes, setNotes] = useState("");

  // When the prompt selection changes, prefill intended_use / context / aspect.
  useEffect(() => {
    const p = prompts.find((pp) => pp.prompt_id === promptId);
    if (!p) return;
    setIntendedUse(p.intended_use);
    setContext(p.context);
    setAspectRatio(p.aspect_ratio);
  }, [promptId, prompts]);

  async function refreshUploads() {
    const r = await fetch("/api/midjourney/uploads", { cache: "no-store" });
    const j = await r.json();
    if (j.ok) setUploads(j.uploads);
  }

  async function refreshAssignments() {
    const r = await fetch("/api/midjourney/assignments", { cache: "no-store" });
    const j = await r.json();
    if (j.ok) setAssignments(j.assignments);
  }

  async function assignUpload(
    upload_id: string,
    format: MidjourneyAssignmentFormat,
    target: MidjourneyAssignmentTargetRole,
  ) {
    setBusy(true);
    setMessage(null);
    try {
      const r = await fetch("/api/midjourney/assignments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          upload_id,
          format,
          target_element_role: target,
          active: true,
        }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        setMessage(`Assign failed: ${j.error ?? r.statusText}`);
      } else {
        setMessage(
          `Assigned ${target}${format ? ` for ${format}` : ""}. Run \`npm run preview:demo\` to apply.`,
        );
        await refreshAssignments();
      }
    } finally {
      setBusy(false);
    }
  }

  async function toggleAssignment(assignment_id: string, active: boolean) {
    setBusy(true);
    try {
      const r = await fetch("/api/midjourney/assignments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignment_id, active }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        setMessage(`Update failed: ${j.error ?? r.statusText}`);
      } else {
        await refreshAssignments();
      }
    } finally {
      setBusy(false);
    }
  }

  async function removeAssignment(assignment_id: string) {
    setBusy(true);
    try {
      const r = await fetch(
        `/api/midjourney/assignments?assignment_id=${encodeURIComponent(assignment_id)}`,
        { method: "DELETE" },
      );
      const j = await r.json();
      if (!r.ok || !j.ok) {
        setMessage(`Delete failed: ${j.error ?? r.statusText}`);
      } else {
        await refreshAssignments();
      }
    } finally {
      setBusy(false);
    }
  }

  async function submitUpload(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);
    if (!file) {
      setMessage("Pick a file first.");
      return;
    }
    if (!promptId) {
      setMessage("Pick a prompt.");
      return;
    }
    setBusy(true);
    const fd = new FormData();
    fd.set("file", file);
    fd.set("prompt_id", promptId);
    fd.set("intended_use", intendedUse);
    fd.set("context", context);
    if (aspectRatio) fd.set("aspect_ratio", aspectRatio);
    if (approved) fd.set("approved", "true");
    if (notes.trim()) fd.set("notes", notes.trim());

    try {
      const r = await fetch("/api/midjourney/uploads", { method: "POST", body: fd });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        setMessage(`Upload failed: ${j.error ?? r.statusText}`);
      } else {
        setMessage(
          `Saved ${j.upload.upload_id}. To use in the demo, run \`npm run preview:demo\`.`,
        );
        setFile(null);
        setNotes("");
        setApproved(false);
        await refreshUploads();
      }
    } catch (err) {
      setMessage(`Upload failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function patchUpload(upload_id: string, patch: { approved?: boolean; notes?: string }) {
    setBusy(true);
    try {
      const r = await fetch("/api/midjourney/uploads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ upload_id, ...patch }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        setMessage(`Patch failed: ${j.error ?? r.statusText}`);
      } else {
        await refreshUploads();
      }
    } finally {
      setBusy(false);
    }
  }

  async function removeUpload(upload_id: string) {
    if (!confirm(`Remove upload ${upload_id}? The local file will be deleted.`)) return;
    setBusy(true);
    try {
      const r = await fetch(
        `/api/midjourney/uploads?upload_id=${encodeURIComponent(upload_id)}`,
        { method: "DELETE" },
      );
      const j = await r.json();
      if (!r.ok || !j.ok) {
        setMessage(`Delete failed: ${j.error ?? r.statusText}`);
      } else {
        await refreshUploads();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <form
        onSubmit={submitUpload}
        className="space-y-3 rounded-md border border-zinc-200 p-4 dark:border-zinc-800"
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Prompt">
            <select
              value={promptId}
              onChange={(e) => setPromptId(e.target.value)}
              className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-950"
            >
              {prompts.map((p) => (
                <option key={p.prompt_id} value={p.prompt_id}>
                  {p.title}
                </option>
              ))}
            </select>
          </Field>

          <Field label="File (PNG / JPG / WEBP)">
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="w-full text-sm"
            />
          </Field>

          <Field label="Intended use">
            <select
              value={intendedUse}
              onChange={(e) => setIntendedUse(e.target.value as MidjourneyIntendedUse)}
              className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-950"
            >
              {INTENDED_USES.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Context">
            <select
              value={context}
              onChange={(e) => setContext(e.target.value as MidjourneyContext)}
              className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-950"
            >
              {CONTEXTS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field label="Notes (optional)">
          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. seed 42, version 6.1, second variation"
            className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-950"
          />
        </Field>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={approved}
            onChange={(e) => setApproved(e.target.checked)}
          />
          Approve immediately (use in demo)
        </label>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={busy || !file}
            className="rounded-md bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          >
            {busy ? "Uploading…" : "Upload"}
          </button>
          {message && <span className="text-xs text-zinc-600 dark:text-zinc-400">{message}</span>}
        </div>
      </form>

      <section>
        <h3 className="mb-2 text-sm font-medium">Existing uploads ({uploads.length})</h3>
        {uploads.length === 0 ? (
          <p className="text-xs text-zinc-500">
            No uploads yet. Run a prompt in Midjourney, download the result, then upload it above.
          </p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {uploads.map((u) => (
              <UploadCard
                key={u.upload_id}
                u={u}
                assignments={assignments.filter((a) => a.upload_id === u.upload_id)}
                onApproveToggle={(checked) => patchUpload(u.upload_id, { approved: checked })}
                onRemove={() => removeUpload(u.upload_id)}
                onAssign={(format, target) => assignUpload(u.upload_id, format, target)}
                onToggleAssignment={(id, active) => toggleAssignment(id, active)}
                onRemoveAssignment={(id) => removeAssignment(id)}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-xs">
      <span className="block text-zinc-500">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

function UploadCard({
  u,
  assignments,
  onApproveToggle,
  onRemove,
  onAssign,
  onToggleAssignment,
  onRemoveAssignment,
}: {
  u: MidjourneyUpload;
  assignments: MidjourneyAssignment[];
  onApproveToggle: (checked: boolean) => void;
  onRemove: () => void;
  onAssign: (
    format: MidjourneyAssignmentFormat,
    target: MidjourneyAssignmentTargetRole,
  ) => void;
  onToggleAssignment: (assignment_id: string, active: boolean) => void;
  onRemoveAssignment: (assignment_id: string) => void;
}) {
  const [assignSelection, setAssignSelection] = useState<string>(
    () => `${ASSIGNMENT_TARGETS[0].format ?? "all"}|${ASSIGNMENT_TARGETS[0].target}`,
  );

  return (
    <li className="rounded-md border border-zinc-200 p-3 text-xs dark:border-zinc-800">
      <div className="grid grid-cols-[120px_1fr] gap-3">
        <div className="flex h-[120px] w-[120px] items-center justify-center overflow-hidden rounded bg-zinc-100 dark:bg-zinc-900">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={u.public_path}
            alt={u.filename}
            className="h-full w-full object-contain"
          />
        </div>
        <div className="min-w-0 space-y-1">
          <div className="truncate font-medium" title={u.filename}>
            {u.filename}
          </div>
          <div className="text-zinc-500">
            <span>{u.intended_use}</span>
            <span className="mx-1">·</span>
            <span>{u.context}</span>
            <span className="mx-1">·</span>
            <span title={u.upload_id}>{u.upload_id.slice(0, 12)}…</span>
          </div>
          <div className="text-zinc-500">prompt: {u.prompt_id}</div>
          {u.notes && <div className="italic text-zinc-500">{u.notes}</div>}
          <div className="flex items-center gap-3 pt-1">
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={u.approved}
                onChange={(e) => onApproveToggle(e.target.checked)}
              />
              Approved
            </label>
            <button
              type="button"
              onClick={onRemove}
              className="text-amber-700 hover:underline dark:text-amber-400"
            >
              Remove
            </button>
          </div>
        </div>
      </div>

      {u.approved && (
        <div className="mt-3 border-t border-zinc-200 pt-2 dark:border-zinc-800">
          <div className="mb-1.5 font-medium">Assignments</div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={assignSelection}
              onChange={(e) => setAssignSelection(e.target.value)}
              className="rounded border border-zinc-300 bg-white px-1.5 py-0.5 text-[11px] dark:border-zinc-700 dark:bg-zinc-950"
            >
              {ASSIGNMENT_TARGETS.map((opt) => {
                const value = `${opt.format ?? "all"}|${opt.target}`;
                return (
                  <option key={value} value={value}>
                    {opt.label}
                  </option>
                );
              })}
            </select>
            <button
              type="button"
              onClick={() => {
                const [fmtRaw, targetRaw] = assignSelection.split("|");
                const format =
                  fmtRaw === "all" ? null : (fmtRaw as MidjourneyAssignmentFormat);
                const target = targetRaw as MidjourneyAssignmentTargetRole;
                onAssign(format, target);
              }}
              className="rounded bg-zinc-900 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900"
            >
              Assign
            </button>
          </div>

          {assignments.length === 0 ? (
            <p className="mt-1 text-[11px] text-zinc-500">
              No assignments yet — without one this upload still counts as a default
              fallback (first-by-intended-use).
            </p>
          ) : (
            <ul className="mt-2 space-y-1">
              {assignments.map((a) => (
                <li key={a.assignment_id} className="flex items-center gap-2">
                  <span
                    className={
                      a.active
                        ? "rounded-full bg-emerald-100 px-1.5 text-[10px] text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
                        : "rounded-full bg-zinc-100 px-1.5 text-[10px] text-zinc-700 dark:bg-zinc-900 dark:text-zinc-400"
                    }
                  >
                    {a.active ? "active" : "inactive"}
                  </span>
                  <span>
                    {a.target_element_role.replaceAll("_", " ")}
                    {a.format ? ` · ${a.format}` : " · all formats"}
                  </span>
                  <button
                    type="button"
                    onClick={() => onToggleAssignment(a.assignment_id, !a.active)}
                    className="text-sky-700 hover:underline dark:text-sky-400"
                  >
                    {a.active ? "deactivate" : "activate"}
                  </button>
                  <button
                    type="button"
                    onClick={() => onRemoveAssignment(a.assignment_id)}
                    className="text-amber-700 hover:underline dark:text-amber-400"
                  >
                    remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}
