import type { ElementManifest } from "@/lib/schemas/elementManifest.schema";
import { ProductionElementLayer } from "@/components/render/ProductionElementLayer";

// ─────────────────────────────────────────────────────────────────────────────
// ProductionAdCanvas — exact native-size render of one Element Manifest.
//
// No scaling, no chrome. The element is `position: fixed` at viewport (0, 0)
// to escape any parent layout's max-width / padding, so the headless screen-
// shot capture can target it cleanly via `#render-canvas`.
//
// Every element is rendered in z_index order (ascending) so the stacking
// matches the manifest. `overflow: hidden` clips elements that overshoot
// the canvas — same as a real ad slot.
// ─────────────────────────────────────────────────────────────────────────────

export const RENDER_CANVAS_ID = "render-canvas";

export interface ProductionAdCanvasProps {
  manifest: ElementManifest;
  // CSS gradient strings per element id, when a background is a gradient
  // shape rather than an image. Keyed by element.id.
  gradientCssById?: Record<string, string>;
  // When true, position the canvas with `position: fixed; top: 0; left: 0`
  // so it escapes any wrapping layout. Default: true. Set false when
  // embedding inside another component (e.g. /code-render-preview).
  fixedAtViewportOrigin?: boolean;
}

export function ProductionAdCanvas({
  manifest,
  gradientCssById,
  fixedAtViewportOrigin = true,
}: ProductionAdCanvasProps) {
  const { width, height } = manifest.size;
  const sortedElements = [...manifest.elements].sort((a, b) => a.z_index - b.z_index);

  const positionStyle: React.CSSProperties = fixedAtViewportOrigin
    ? { position: "fixed", top: 0, left: 0, zIndex: 9999 }
    : { position: "relative" };

  return (
    <div
      id={RENDER_CANVAS_ID}
      data-render-canvas
      data-canvas-width={width}
      data-canvas-height={height}
      style={{
        ...positionStyle,
        width,
        height,
        overflow: "hidden",
        background: "#000",
      }}
    >
      {sortedElements.map((el) => (
        <ProductionElementLayer
          key={el.id}
          element={el}
          gradientCssById={gradientCssById}
        />
      ))}
    </div>
  );
}
