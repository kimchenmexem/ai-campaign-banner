import type { Element } from "@/lib/schemas/elementManifest.schema";

// ─────────────────────────────────────────────────────────────────────────────
// ElementLayer — renders one Element from the manifest at its absolute
// position. Branches on element.type:
//   - background image / shape (gradient via inline CSS from the demo file)
//   - text / headline / subheadline / legal-disclaimer
//   - image / logo
//   - cta-button
// Renders inside a parent that already applies the canvas-scale transform,
// so coordinates here are in the manifest's native pixel space.
// ─────────────────────────────────────────────────────────────────────────────

export interface ElementLayerProps {
  element: Element;
  // The demo writes a `file://localhost/...` URL for image elements so the
  // schema validates. The canvas resolves that back to the public path.
  resolveImageUrl?: (fileUrl: string) => string;
  // For gradient backgrounds we look up the css string by element id from
  // the demo's asset_selection.
  gradientCssById?: Record<string, string>;
}

const FILE_URL_PREFIX = "file://localhost";

function defaultResolveImageUrl(fileUrl: string): string {
  if (fileUrl.startsWith(FILE_URL_PREFIX)) return fileUrl.slice(FILE_URL_PREFIX.length);
  return fileUrl;
}

export function ElementLayer({
  element: el,
  resolveImageUrl = defaultResolveImageUrl,
  gradientCssById,
}: ElementLayerProps) {
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

  // Background — either an image (file_url) or a CSS gradient.
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

  // Image-typed elements (logo, mockup, hero, screenshot) — anything with file_url.
  if (el.file_url && (el.type === "image" || el.type === "logo" || el.type === "icon")) {
    const dropShadow = el.shadow
      ? `drop-shadow(${el.shadow.x ?? 0}px ${el.shadow.y ?? 0}px ${el.shadow.blur ?? 0}px ${el.shadow.color ?? "rgba(0,0,0,0.4)"})`
      : undefined;
    // Mirror ProductionElementLayer: logos anchor top-left in their bbox so
    // internal PNG padding doesn't push them away from the corner.
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

  // CTA button — real text inside a styled frame.
  if (el.type === "cta-button") {
    const radius = el.border_radius ?? 0;
    return (
      <div
        role="button"
        style={{
          ...baseStyle,
          display: "flex",
          alignItems: "center",
          justifyContent: el.text_align === "left" ? "flex-start" : el.text_align === "right" ? "flex-end" : "center",
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
          border: el.border_width ? `${el.border_width}px solid ${el.border_color ?? "transparent"}` : undefined,
          whiteSpace: "nowrap",
          overflow: "hidden",
        }}
      >
        {el.text}
      </div>
    );
  }

  // Text / headline / subheadline / legal-disclaimer / body etc.
  // Mirrors the same two-color split path as ProductionElementLayer (so
  // the live local preview matches the captured PNG byte-for-byte on
  // headline rendering).
  if (el.type === "text" || el.type === "legal" || el.text !== undefined) {
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

  // Fallback for shape / decorative (e.g. unhandled background_color element).
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
