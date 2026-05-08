import type { ElementManifest } from "@/lib/schemas/elementManifest.schema";
import { ElementLayer } from "@/components/preview/ElementLayer";

// ─────────────────────────────────────────────────────────────────────────────
// AdPreviewCanvas — renders one ad's manifest as a positioned HTML preview.
//
// Strategy:
//   - The inner div is fixed at manifest.size (native pixels).
//   - A transform: scale() on a wrapper fits it inside the available width.
//   - Elements are rendered in z_index order (sort ascending; later elements
//     stack on top via natural DOM order plus zIndex).
//
// This is preview-only. Bannerbear later renders the same manifest as a flat
// PNG; Figma later imports the same manifest as editable nodes. No layout
// math here is authoritative — the manifest is.
// ─────────────────────────────────────────────────────────────────────────────

export interface AdPreviewCanvasProps {
  manifest: ElementManifest;
  // Maximum width the wrapper is allowed to occupy. The canvas scales down to
  // fit. Pass null/undefined for native size.
  maxWidth?: number;
  // Map of element-id → CSS gradient string, when the element's background
  // is a CSS fill rather than an image asset.
  gradientCssById?: Record<string, string>;
  // Override how `file://localhost/...` URLs in element file_url resolve.
  resolveImageUrl?: (url: string) => string;
}

export function AdPreviewCanvas({
  manifest,
  maxWidth,
  gradientCssById,
  resolveImageUrl,
}: AdPreviewCanvasProps) {
  const { width, height } = manifest.size;
  const scale = maxWidth && maxWidth < width ? maxWidth / width : 1;
  const sortedElements = [...manifest.elements].sort((a, b) => a.z_index - b.z_index);

  return (
    <div className="space-y-2">
      <div className="text-xs text-zinc-500 dark:text-zinc-400">
        Native: {width} × {height}px · Preview scale: {(scale * 100).toFixed(0)}%
      </div>
      <div
        style={{
          width: width * scale,
          height: height * scale,
          overflow: "hidden",
          position: "relative",
        }}
        className="rounded-md ring-1 ring-zinc-300 dark:ring-zinc-700 bg-zinc-100 dark:bg-zinc-900"
      >
        <div
          style={{
            width,
            height,
            position: "relative",
            transform: `scale(${scale})`,
            transformOrigin: "top left",
          }}
        >
          {sortedElements.map((el) => (
            <ElementLayer
              key={el.id}
              element={el}
              gradientCssById={gradientCssById}
              resolveImageUrl={resolveImageUrl}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
