import type { Element } from "@/lib/schemas/elementManifest.schema";

// ─────────────────────────────────────────────────────────────────────────────
// ProductionElementLayer — renders one Element from the manifest at native
// pixel size, no scaling, no display tweaks. The output of this component
// (sitting inside ProductionAdCanvas) is what the headless screenshot captures.
//
// Rules (per-task spec):
//   - real text layers   (text content, font_family, font_weight, font_size,
//                         line_height, letter_spacing, text_align, color)
//   - real image layers  (file_url + object_fit; no rasterizing)
//   - real CTA layers    (background_color, color, padding, border_radius)
//   - real disclaimer    (text content, color, alignment)
//   - preserve x/y/width/height/z_index/opacity/rotation
//   - support both Cloudinary URLs and local public_path fallbacks
//
// The Element Manifest is the only source of truth — this component never
// invents positions or styling.
// ─────────────────────────────────────────────────────────────────────────────

const FILE_URL_PREFIX = "file://localhost";

function resolveImageUrl(fileUrl: string): string {
  if (fileUrl.startsWith(FILE_URL_PREFIX)) {
    return fileUrl.slice(FILE_URL_PREFIX.length);
  }
  return fileUrl;
}

export interface ProductionElementLayerProps {
  element: Element;
  // For background elements that use a CSS gradient (no file_url), the demo
  // file's asset_selection records the linear-gradient(...) string. Keyed by
  // element id.
  gradientCssById?: Record<string, string>;
}

export function ProductionElementLayer({
  element: el,
  gradientCssById,
}: ProductionElementLayerProps) {
  if (!el.visible) return null;

  const baseStyle: React.CSSProperties = {
    position: "absolute",
    left: el.x,
    top: el.y,
    width: el.width,
    height: el.height,
    zIndex: el.z_index,
    opacity: el.opacity,
    transform: el.rotation ? `rotate(${el.rotation}deg)` : undefined,
    transformOrigin: "center center",
  };

  // ── Background ───────────────────────────────────────────────────────────
  if (el.role === "background") {
    if (el.file_url) {
      return (
        <img
          alt={el.alt_text ?? ""}
          src={resolveImageUrl(el.file_url)}
          style={{
            ...baseStyle,
            objectFit: el.object_fit ?? "cover",
            objectPosition: "center",
          }}
        />
      );
    }
    const css = gradientCssById?.[el.id];
    return (
      <div
        style={{
          ...baseStyle,
          background: css ?? el.background_color ?? "#000",
        }}
        aria-hidden
      />
    );
  }

  // ── Image elements (logo, mockup, screenshot, product_visual, decorative) ─
  if (
    el.file_url &&
    (el.type === "image" ||
      el.type === "logo" ||
      el.type === "icon" ||
      el.role === "product_visual")
  ) {
    // Brand rule: the visual element blends into the gradient via a soft
    // drop shadow. Applied with CSS `filter: drop-shadow(...)` so it follows
    // the actual transparent shape of the PNG (device silhouette), not the
    // bounding rectangle. el.shadow.x/y/blur/color come from the manifest.
    const dropShadow = el.shadow
      ? `drop-shadow(${el.shadow.x ?? 0}px ${el.shadow.y ?? 0}px ${el.shadow.blur ?? 0}px ${el.shadow.color ?? "rgba(0,0,0,0.4)"})`
      : undefined;
    // Logo elements anchor to the TOP-LEFT of their bbox (so internal PNG
    // padding doesn't push the visible wordmark away from the corner).
    // Other images stay centered as before.
    const objectPosition =
      el.role === "logo" || el.type === "logo" ? "left top" : "center";
    return (
      <img
        alt={el.alt_text ?? ""}
        src={resolveImageUrl(el.file_url)}
        style={{
          ...baseStyle,
          objectFit: el.object_fit ?? "contain",
          objectPosition,
          ...(dropShadow ? { filter: dropShadow } : {}),
        }}
      />
    );
  }

  // ── CTA button: real frame + real text ───────────────────────────────────
  if (el.type === "cta-button") {
    const radius = el.border_radius ?? 0;
    return (
      <div
        role="button"
        style={{
          ...baseStyle,
          display: "flex",
          alignItems: "center",
          justifyContent:
            el.text_align === "left"
              ? "flex-start"
              : el.text_align === "right"
                ? "flex-end"
                : "center",
          backgroundColor: el.background_color ?? "#3B82F6",
          color: el.color ?? "#FFFFFF",
          borderRadius: radius,
          padding: el.padding
            ? `${el.padding.top ?? 0}px ${el.padding.right ?? 0}px ${el.padding.bottom ?? 0}px ${el.padding.left ?? 0}px`
            : undefined,
          fontFamily: el.font_family ? `"${el.font_family}", sans-serif` : undefined,
          fontWeight: el.font_weight ?? 600,
          fontSize: el.font_size ?? 32,
          lineHeight: el.line_height ?? 1.1,
          letterSpacing: el.letter_spacing ?? 0,
          border: el.border_width
            ? `${el.border_width}px solid ${el.border_color ?? "transparent"}`
            : undefined,
          whiteSpace: "nowrap",
          overflow: "hidden",
        }}
      >
        {el.text}
      </div>
    );
  }

  // ── Text / headline / subheadline / body / legal-disclaimer ──────────────
  if (el.type === "text" || el.type === "legal" || typeof el.text === "string") {
    // Two-color split rendering for the MEXEM reference headline rule.
    // When `emphasis_text` is set and is a prefix of `text`, we paint the
    // prefix in `emphasis_color` and the rest in `color`. Both spans live
    // in the SAME text block so they wrap as one paragraph — matching
    // the references' "yellow first clause / white rest" treatment.
    const text = el.text ?? "";
    const useEmphasis =
      el.emphasis_text &&
      text.startsWith(el.emphasis_text) &&
      el.emphasis_text.length > 0 &&
      el.emphasis_text.length < text.length;
    const restText = useEmphasis ? text.slice(el.emphasis_text!.length) : text;
    return (
      <div
        style={{
          ...baseStyle,
          color: el.color ?? "#FFFFFF",
          fontFamily: el.font_family ? `"${el.font_family}", sans-serif` : undefined,
          fontWeight: el.font_weight ?? 400,
          fontSize: el.font_size ?? 16,
          lineHeight: el.line_height ?? 1.4,
          letterSpacing: el.letter_spacing ?? 0,
          textAlign: el.text_align ?? "left",
          display: "flex",
          alignItems: "flex-start",
          justifyContent:
            el.text_align === "right"
              ? "flex-end"
              : el.text_align === "center"
                ? "center"
                : "flex-start",
        }}
      >
        <span style={{ width: "100%" }}>
          {useEmphasis && (
            <span style={{ color: el.emphasis_color ?? "#F5C518" }}>
              {el.emphasis_text}
            </span>
          )}
          <span>{restText}</span>
        </span>
      </div>
    );
  }

  // ── Plain shape (e.g. solid color rect) ──────────────────────────────────
  if (el.background_color) {
    return (
      <div
        style={{
          ...baseStyle,
          backgroundColor: el.background_color,
          borderRadius: el.border_radius ?? 0,
        }}
        aria-hidden
      />
    );
  }

  return null;
}
