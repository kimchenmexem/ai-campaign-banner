"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AssetPreviewRecord } from "@/lib/preview/copyPreviewAssets";
import type {
  DeviceType,
  MockupManifestEntry,
  Point,
  ScreenSlot,
} from "@/lib/preview/mockupManifest";

const DEVICES: DeviceType[] = ["phone", "tablet", "laptop", "desktop", "smartwatch"];

const HEURISTIC_PCT: Record<Exclude<DeviceType, "unknown">, ScreenSlot & { _isPct: true }> = {
  phone: { x: 0.07, y: 0.04, width: 0.86, height: 0.92, border_radius: 0.07, _isPct: true },
  tablet: { x: 0.09, y: 0.05, width: 0.82, height: 0.9, border_radius: 0.04, _isPct: true },
  laptop: { x: 0.13, y: 0.06, width: 0.74, height: 0.62, border_radius: 0.01, _isPct: true },
  desktop: { x: 0.08, y: 0.04, width: 0.84, height: 0.7, border_radius: 0.005, _isPct: true },
  smartwatch: { x: 0.18, y: 0.18, width: 0.64, height: 0.64, border_radius: 0.18, _isPct: true },
};

interface RowState {
  device_type: DeviceType;
  slot: ScreenSlot;
  notes: string;
  source: "explicit_manifest" | "heuristic";
}

const DISPLAY_MAX_W = 600;

export interface MockupCalibratorProps {
  mockups: AssetPreviewRecord[];
  initialEntries: MockupManifestEntry[];
}

export function MockupCalibrator({ mockups, initialEntries }: MockupCalibratorProps) {
  const initialMap = useMemo(() => {
    const m = new Map<string, MockupManifestEntry>();
    for (const e of initialEntries) m.set(e.filename.toLowerCase(), e);
    return m;
  }, [initialEntries]);

  const [activeIndex, setActiveIndex] = useState(0);
  const [naturalDims, setNaturalDims] = useState<{ width: number; height: number } | null>(null);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const active = mockups[activeIndex];

  // Lazy-init the row for the active mockup once natural dims are known.
  useEffect(() => {
    if (!active || !naturalDims) return;
    const key = active.original_filename;
    if (rows[key]) return;
    const existing = initialMap.get(key.toLowerCase());
    if (existing) {
      setRows((prev) => ({
        ...prev,
        [key]: {
          device_type: existing.device_type,
          slot: { ...existing.screen_slot },
          notes: existing.notes ?? "",
          source: "explicit_manifest",
        },
      }));
      return;
    }
    const device = inferDevice(active.original_filename);
    const pct = HEURISTIC_PCT[device as Exclude<DeviceType, "unknown">] ?? HEURISTIC_PCT.tablet;
    setRows((prev) => ({
      ...prev,
      [key]: {
        device_type: device === "unknown" ? "tablet" : device,
        slot: pctToSlot(pct, naturalDims.width, naturalDims.height),
        notes: "",
        source: "heuristic",
      },
    }));
  }, [active, naturalDims, rows, initialMap]);

  // Reset natural dims when switching mockups (the new image will fire onLoad).
  useEffect(() => setNaturalDims(null), [activeIndex]);

  if (!active) {
    return (
      <div className="rounded-md border border-zinc-200 p-4 text-sm dark:border-zinc-800">
        No mockups in inventory. Run <code>npm run preview:assets</code> first.
      </div>
    );
  }

  const row = rows[active.original_filename];
  const scale = naturalDims ? Math.min(1, DISPLAY_MAX_W / naturalDims.width) : 1;
  const perspectiveOn = !!row?.slot.corners;

  function patchSlot(patch: Partial<ScreenSlot>) {
    setRows((prev) => {
      const cur = prev[active.original_filename];
      if (!cur) return prev;
      return {
        ...prev,
        [active.original_filename]: {
          ...cur,
          slot: { ...cur.slot, ...patch },
        },
      };
    });
  }

  function setCorners(corners: [Point, Point, Point, Point]) {
    setRows((prev) => {
      const cur = prev[active.original_filename];
      if (!cur) return prev;
      const bbox = boundingBox(corners);
      return {
        ...prev,
        [active.original_filename]: {
          ...cur,
          slot: {
            ...cur.slot,
            corners,
            x: bbox.x,
            y: bbox.y,
            width: bbox.width,
            height: bbox.height,
          },
        },
      };
    });
  }

  function togglePerspective() {
    setRows((prev) => {
      const cur = prev[active.original_filename];
      if (!cur) return prev;
      if (cur.slot.corners) {
        // Off → drop corners, keep bounding box.
        const { corners: _drop, ...rect } = cur.slot;
        void _drop;
        return {
          ...prev,
          [active.original_filename]: { ...cur, slot: rect },
        };
      }
      // On → seed corners from current rect.
      const seeded: [Point, Point, Point, Point] = [
        { x: cur.slot.x, y: cur.slot.y },
        { x: cur.slot.x + cur.slot.width, y: cur.slot.y },
        { x: cur.slot.x + cur.slot.width, y: cur.slot.y + cur.slot.height },
        { x: cur.slot.x, y: cur.slot.y + cur.slot.height },
      ];
      return {
        ...prev,
        [active.original_filename]: {
          ...cur,
          slot: { ...cur.slot, corners: seeded },
        },
      };
    });
  }

  async function saveAll() {
    setSaving(true);
    setMessage(null);
    const entries: MockupManifestEntry[] = Object.entries(rows).map(([filename, r]) => ({
      filename,
      device_type: r.device_type,
      screen_slot: r.slot,
      ...(r.notes.trim() ? { notes: r.notes.trim() } : {}),
    }));
    try {
      const res = await fetch("/api/mockup-manifest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setMessage(`Save failed: ${data.error ?? res.statusText}`);
      } else {
        setMessage(
          `Saved ${data.count} entries. Run \`npm run preview:mockups\` to regenerate composites.`,
        );
      }
    } catch (err) {
      setMessage(`Save failed: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  const dirtyCount = Object.keys(rows).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm dark:border-zinc-800 dark:bg-zinc-900">
        <div className="space-x-2">
          <button
            type="button"
            disabled={activeIndex === 0}
            onClick={() => setActiveIndex((i) => Math.max(0, i - 1))}
            className="rounded-md border border-zinc-300 px-2 py-1 disabled:opacity-50 dark:border-zinc-700"
          >
            ← Prev
          </button>
          <span className="text-zinc-500">
            {activeIndex + 1} / {mockups.length}
          </span>
          <button
            type="button"
            disabled={activeIndex === mockups.length - 1}
            onClick={() => setActiveIndex((i) => Math.min(mockups.length - 1, i + 1))}
            className="rounded-md border border-zinc-300 px-2 py-1 disabled:opacity-50 dark:border-zinc-700"
          >
            Next →
          </button>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-500">{dirtyCount} edited</span>
          <button
            type="button"
            onClick={saveAll}
            disabled={saving || dirtyCount === 0}
            className="rounded-md bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          >
            {saving ? "Saving…" : "Save all"}
          </button>
        </div>
      </div>
      {message && (
        <div className="rounded-md border border-emerald-300 bg-emerald-50 p-2 text-xs text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100">
          {message}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div>
          <CalibratorCanvas
            src={active.public_path}
            naturalDims={naturalDims}
            slot={row?.slot ?? null}
            scale={scale}
            onNaturalDims={setNaturalDims}
            onSlotChange={(s) => patchSlot(s)}
            onCornersChange={setCorners}
          />
          <div className="mt-2 truncate text-xs text-zinc-500" title={active.original_filename}>
            {active.original_filename}{" "}
            {naturalDims && (
              <span className="opacity-70">
                · native {naturalDims.width}×{naturalDims.height}px · scale{" "}
                {(scale * 100).toFixed(0)}%
              </span>
            )}
          </div>
        </div>

        <div className="space-y-3 rounded-md border border-zinc-200 p-3 text-sm dark:border-zinc-800">
          <div>
            <label className="block text-xs text-zinc-500">Device type</label>
            <select
              value={row?.device_type ?? "tablet"}
              onChange={(e) =>
                setRows((prev) => ({
                  ...prev,
                  [active.original_filename]: {
                    ...prev[active.original_filename],
                    device_type: e.target.value as DeviceType,
                  },
                }))
              }
              className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-950"
            >
              {DEVICES.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>

          <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs dark:border-amber-700 dark:bg-amber-950/40">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={perspectiveOn}
                onChange={togglePerspective}
              />
              <span className="font-medium">Perspective mode (4 corners)</span>
            </label>
            <p className="mt-1 text-amber-900 dark:text-amber-200">
              Use this for screens at oblique angles. Drag each corner to the
              actual edge of the screen glass.
            </p>
          </div>

          {perspectiveOn ? (
            <div className="space-y-2">
              {(row?.slot.corners ?? []).map((c, i) => (
                <div key={i} className="grid grid-cols-[5rem_1fr_1fr] items-center gap-2">
                  <label className="text-xs text-zinc-500">{cornerLabel(i)}</label>
                  <input
                    type="number"
                    value={Math.round(c.x)}
                    onChange={(e) => {
                      const corners = [...(row?.slot.corners ?? [])] as [Point, Point, Point, Point];
                      corners[i] = { x: Number(e.target.value) || 0, y: c.y };
                      setCorners(corners);
                    }}
                    className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-950"
                  />
                  <input
                    type="number"
                    value={Math.round(c.y)}
                    onChange={(e) => {
                      const corners = [...(row?.slot.corners ?? [])] as [Point, Point, Point, Point];
                      corners[i] = { x: c.x, y: Number(e.target.value) || 0 };
                      setCorners(corners);
                    }}
                    className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-950"
                  />
                </div>
              ))}
              <BorderRadiusRow
                value={row?.slot.border_radius ?? 0}
                // In perspective mode the rounding is clipped on the screenshot's
                // source rect *before* the affine warp, so the slot bounding box
                // (which can be much smaller than the actual screen) is not the
                // right reference. Use the longest visible quad edge / 2 as a
                // reasonable cap — enough range that users can reach "fully
                // rounded" in the rendered result.
                maxValue={Math.floor(longestQuadEdge(row?.slot.corners) / 2)}
                onChange={(v) => patchSlot({ border_radius: v })}
              />
              <p className="text-[11px] text-zinc-500">
                The compositor uses an SVG affine warp (TL, TR, BL — the BR
                corner is implied). Slight obliques look perfect; extreme
                perspective is approximated. Rounded edges are clipped before
                the warp, so they ride the perspective.
              </p>
            </div>
          ) : (
            <>
              <NumberRow
                label="x"
                value={row?.slot.x ?? 0}
                onChange={(v) => patchSlot({ x: v })}
              />
              <NumberRow
                label="y"
                value={row?.slot.y ?? 0}
                onChange={(v) => patchSlot({ y: v })}
              />
              <NumberRow
                label="width"
                value={row?.slot.width ?? 0}
                onChange={(v) => patchSlot({ width: v })}
              />
              <NumberRow
                label="height"
                value={row?.slot.height ?? 0}
                onChange={(v) => patchSlot({ height: v })}
              />
              <NumberRow
                label="border_radius"
                value={row?.slot.border_radius ?? 0}
                onChange={(v) => patchSlot({ border_radius: v })}
              />
            </>
          )}

          <div>
            <label className="block text-xs text-zinc-500">Notes</label>
            <input
              type="text"
              value={row?.notes ?? ""}
              onChange={(e) =>
                setRows((prev) => ({
                  ...prev,
                  [active.original_filename]: {
                    ...prev[active.original_filename],
                    notes: e.target.value,
                  },
                }))
              }
              placeholder="Optional"
              className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-950"
            />
          </div>

          <p className="text-[11px] text-zinc-500">
            {perspectiveOn
              ? "Drag each numbered corner in the preview, or edit pixel coordinates above."
              : "Drag the rectangle in the preview to move it; use the inputs for precise values."}{" "}
            All numbers are in mockup-image pixels.
          </p>
        </div>
      </div>
    </div>
  );
}

function BorderRadiusRow({
  value,
  maxValue,
  onChange,
}: {
  value: number;
  maxValue: number;
  onChange: (v: number) => void;
}) {
  // The geometric limit: when border_radius reaches min(w,h)/2, the rounded
  // corners meet in the middle and the rect is already an ellipse. Going
  // higher has no visual effect — the compositor clamps internally. We use
  // this as the slider's max but let the number input accept higher values
  // so the user is never blocked from typing.
  const sliderMax = Math.max(maxValue, 1);
  const sliderValue = Math.min(sliderMax, Math.max(0, Math.round(value)));
  const exceeds = value > sliderMax;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <label className="text-xs text-zinc-500">
          border_radius
          {exceeds && (
            <span
              className="ml-1 text-amber-700 dark:text-amber-400"
              title={`Values above ${sliderMax} have no visible effect — the corners already meet at min(width, height) / 2.`}
            >
              · clamped at {sliderMax}px
            </span>
          )}
        </label>
        <span className="text-xs text-zinc-500">{Math.round(value)} px</span>
      </div>
      <div className="grid grid-cols-[1fr_5rem] items-center gap-2">
        <input
          type="range"
          min={0}
          max={sliderMax}
          step={1}
          value={sliderValue}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-full"
        />
        <input
          type="number"
          min={0}
          value={Math.round(value)}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n) && n >= 0) onChange(n);
          }}
          className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-950"
        />
      </div>
      <div className="text-[10px] text-zinc-500">
        slider tops out at {sliderMax}px (= min(width, height) / 2). Above
        that the rectangle is already an ellipse.
      </div>
    </div>
  );
}

function NumberRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="grid grid-cols-[7rem_1fr] items-center gap-2">
      <label className="text-xs text-zinc-500">{label}</label>
      <input
        type="number"
        value={Number.isFinite(value) ? Math.round(value) : 0}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n) && n >= 0) onChange(n);
        }}
        className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-950"
      />
    </div>
  );
}

function CalibratorCanvas({
  src,
  naturalDims,
  slot,
  scale,
  onNaturalDims,
  onSlotChange,
  onCornersChange,
}: {
  src: string;
  naturalDims: { width: number; height: number } | null;
  slot: ScreenSlot | null;
  scale: number;
  onNaturalDims: (d: { width: number; height: number }) => void;
  onSlotChange: (patch: Partial<ScreenSlot>) => void;
  onCornersChange: (corners: [Point, Point, Point, Point]) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragRect = useRef<{ originX: number; originY: number; slotX: number; slotY: number } | null>(null);
  const dragCorner = useRef<{ index: number; originX: number; originY: number; cornerX: number; cornerY: number } | null>(null);
  // Mirror `slot` into a ref so the global mousemove handler always sees the
  // latest value without having to be re-bound on every render.
  const slotRef = useRef<ScreenSlot | null>(slot);
  useEffect(() => {
    slotRef.current = slot;
  }, [slot]);

  function startDragRect(ev: React.MouseEvent) {
    if (!slot || slot.corners) return;
    ev.preventDefault();
    dragRect.current = {
      originX: ev.clientX,
      originY: ev.clientY,
      slotX: slot.x,
      slotY: slot.y,
    };
    window.addEventListener("mousemove", onMoveRect);
    window.addEventListener("mouseup", onUpRect);
  }
  function onMoveRect(ev: MouseEvent) {
    const d = dragRect.current;
    if (!d) return;
    const dx = (ev.clientX - d.originX) / scale;
    const dy = (ev.clientY - d.originY) / scale;
    onSlotChange({
      x: Math.max(0, Math.round(d.slotX + dx)),
      y: Math.max(0, Math.round(d.slotY + dy)),
    });
  }
  function onUpRect() {
    dragRect.current = null;
    window.removeEventListener("mousemove", onMoveRect);
    window.removeEventListener("mouseup", onUpRect);
  }

  function startDragCorner(index: number, ev: React.MouseEvent) {
    if (!slot?.corners) return;
    ev.preventDefault();
    ev.stopPropagation();
    dragCorner.current = {
      index,
      originX: ev.clientX,
      originY: ev.clientY,
      cornerX: slot.corners[index].x,
      cornerY: slot.corners[index].y,
    };
    window.addEventListener("mousemove", onMoveCorner);
    window.addEventListener("mouseup", onUpCorner);
  }
  function onMoveCorner(ev: MouseEvent) {
    const d = dragCorner.current;
    const cur = slotRef.current;
    if (!d || !cur?.corners) return;
    const dx = (ev.clientX - d.originX) / scale;
    const dy = (ev.clientY - d.originY) / scale;
    const next: [Point, Point, Point, Point] = [
      { ...cur.corners[0] },
      { ...cur.corners[1] },
      { ...cur.corners[2] },
      { ...cur.corners[3] },
    ];
    next[d.index] = {
      x: Math.max(0, Math.round(d.cornerX + dx)),
      y: Math.max(0, Math.round(d.cornerY + dy)),
    };
    onCornersChange(next);
  }
  function onUpCorner() {
    dragCorner.current = null;
    window.removeEventListener("mousemove", onMoveCorner);
    window.removeEventListener("mouseup", onUpCorner);
  }

  const containerW = naturalDims ? naturalDims.width * scale : DISPLAY_MAX_W;
  const containerH = naturalDims ? naturalDims.height * scale : DISPLAY_MAX_W * 0.75;

  return (
    <div
      ref={containerRef}
      style={{
        width: containerW,
        height: containerH,
        position: "relative",
        userSelect: "none",
      }}
      className="overflow-hidden rounded-md ring-1 ring-zinc-300 dark:ring-zinc-700"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt=""
        style={{ width: "100%", height: "100%", objectFit: "contain" }}
        onLoad={(e) => {
          const img = e.currentTarget;
          onNaturalDims({ width: img.naturalWidth, height: img.naturalHeight });
        }}
      />
      {slot && naturalDims && !slot.corners && (
        <div
          onMouseDown={startDragRect}
          style={{
            position: "absolute",
            left: slot.x * scale,
            top: slot.y * scale,
            width: slot.width * scale,
            height: slot.height * scale,
            outline: "2px solid #3b82f6",
            outlineOffset: -1,
            background: "rgba(59,130,246,0.12)",
            borderRadius: (slot.border_radius ?? 0) * scale,
            cursor: "move",
          }}
        />
      )}
      {slot?.corners && naturalDims && (
        <>
          <svg
            style={{
              position: "absolute",
              inset: 0,
              width: containerW,
              height: containerH,
              pointerEvents: "none",
            }}
          >
            <path
              d={roundedQuadPath(slot.corners, slot.border_radius ?? 0, scale)}
              fill="rgba(59,130,246,0.18)"
              stroke="#3b82f6"
              strokeWidth={2}
            />
          </svg>
          {slot.corners.map((c, i) => (
            <div
              key={i}
              onMouseDown={(ev) => startDragCorner(i, ev)}
              title={cornerLabel(i)}
              style={{
                position: "absolute",
                left: c.x * scale - 8,
                top: c.y * scale - 8,
                width: 16,
                height: 16,
                borderRadius: "50%",
                background: "#3b82f6",
                color: "white",
                fontSize: 10,
                fontWeight: 600,
                lineHeight: "16px",
                textAlign: "center",
                cursor: "grab",
                border: "2px solid white",
                boxShadow: "0 0 0 1px rgba(0,0,0,0.4)",
              }}
            >
              {i + 1}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function pctToSlot(
  pct: { x: number; y: number; width: number; height: number; border_radius?: number },
  imgW: number,
  imgH: number,
): ScreenSlot {
  const w = Math.round(imgW * pct.width);
  const h = Math.round(imgH * pct.height);
  return {
    x: Math.round(imgW * pct.x),
    y: Math.round(imgH * pct.y),
    width: w,
    height: h,
    border_radius: pct.border_radius
      ? Math.round(Math.min(w, h) * pct.border_radius)
      : 0,
  };
}

function inferDevice(filename: string): DeviceType {
  const v = filename.toLowerCase();
  if (/iphone|phone|mobile/.test(v)) return "phone";
  if (/ipad|tablet/.test(v)) return "tablet";
  if (/macbook|laptop|notebook/.test(v)) return "laptop";
  if (/desktop|imac|monitor/.test(v)) return "desktop";
  if (/iwatch|watch/.test(v)) return "smartwatch";
  return "unknown";
}

// Build an SVG path that draws a closed quadrilateral with rounded corners.
// At each corner we step `r` pixels back along the previous edge, draw a
// quadratic curve through the corner, and emerge `r` pixels along the next
// edge. r is clamped per corner to half the shorter adjacent edge so a
// short side never causes the curves to overshoot.
function roundedQuadPath(corners: Point[], radius: number, scale: number): string {
  if (corners.length !== 4) return "";
  if (radius <= 0) {
    return (
      corners
        .map(
          (c, i) => `${i === 0 ? "M" : "L"} ${c.x * scale} ${c.y * scale}`,
        )
        .join(" ") + " Z"
    );
  }
  const segs: string[] = [];
  for (let i = 0; i < 4; i++) {
    const prev = corners[(i + 3) % 4];
    const cur = corners[i];
    const next = corners[(i + 1) % 4];
    const dPrev = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    const dNext = Math.hypot(next.x - cur.x, next.y - cur.y);
    if (dPrev === 0 || dNext === 0) continue;
    const r = Math.min(radius, dPrev / 2, dNext / 2);
    const ux1 = (cur.x - prev.x) / dPrev;
    const uy1 = (cur.y - prev.y) / dPrev;
    const ux2 = (next.x - cur.x) / dNext;
    const uy2 = (next.y - cur.y) / dNext;
    const startX = (cur.x - ux1 * r) * scale;
    const startY = (cur.y - uy1 * r) * scale;
    const endX = (cur.x + ux2 * r) * scale;
    const endY = (cur.y + uy2 * r) * scale;
    segs.push(`${i === 0 ? "M" : "L"} ${startX} ${startY}`);
    segs.push(`Q ${cur.x * scale} ${cur.y * scale} ${endX} ${endY}`);
  }
  segs.push("Z");
  return segs.join(" ");
}

function longestQuadEdge(corners: Point[] | undefined): number {
  if (!corners || corners.length !== 4) return 0;
  let max = 0;
  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    if (d > max) max = d;
  }
  return max;
}

function boundingBox(corners: Point[]): { x: number; y: number; width: number; height: number } {
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    x: Math.max(0, Math.round(x)),
    y: Math.max(0, Math.round(y)),
    width: Math.max(1, Math.round(Math.max(...xs) - x)),
    height: Math.max(1, Math.round(Math.max(...ys) - y)),
  };
}

function cornerLabel(i: number): string {
  return ["1 · top-left", "2 · top-right", "3 · bottom-right", "4 · bottom-left"][i] ?? `${i + 1}`;
}
