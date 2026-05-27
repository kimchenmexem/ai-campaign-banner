"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ALL_CAMPAIGN_FORMATS } from "@/lib/settings/campaignDefaults.schema";
import type { CampaignFormat } from "@/lib/schemas/campaignBrief.schema";
import { LANG_META, LANGUAGES, type Language } from "@/lib/i18n/language";

type TextRole =
  | "logo"
  | "headline"
  | "subheadline"
  | "body"
  | "cta"
  | "disclaimer"
  | "locked";
type FitMode = "contain" | "cover";
type TranslationStatus = "idle" | "running" | "done" | "error";
type SaveStatus = "idle" | "saving" | "done" | "error";
type SourceMode = "editable-text" | "outlined-vector";
type OutlinedSliceRole = "brand" | "headline" | "cta" | "disclaimer" | "visual";

interface Props {
  defaultDisclaimer: string;
  disclaimersByLanguage: Partial<Record<Language, string>>;
}

interface TextLayer {
  index: number;
  sourceText: string;
  role: TextRole;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  fontFamily: string;
  fontWeight: string;
  fill: string;
  textAnchor: string;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface OutlinedSlice extends Box {
  id: string;
  role: OutlinedSliceRole;
}

interface ParsedSvg {
  svg: string;
  artworkInner: string;
  sourceDefsInner: string;
  backgroundInner: string;
  outlinedForegroundInner: string;
  width: number;
  height: number;
  viewBox: [number, number, number, number];
  layers: TextLayer[];
  mode: SourceMode;
  outlinedSlices: OutlinedSlice[];
}

interface VariantSvg {
  key: string;
  language: Language;
  format: CampaignFormat;
  width: number;
  height: number;
  svg: string;
  warnings: string[];
}

interface Matrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

interface OutlinedPlacement extends Box {
  slice: OutlinedSlice;
  preserveAspectRatio: "xMidYMid meet" | "xMidYMid slice";
}

const FORMAT_SIZE: Record<CampaignFormat, { width: number; height: number }> = {
  "1200x628": { width: 1200, height: 628 },
  "1080x1080": { width: 1080, height: 1080 },
  "1080x1920": { width: 1080, height: 1920 },
  "1200x1200": { width: 1200, height: 1200 },
  "300x250": { width: 300, height: 250 },
  "336x280": { width: 336, height: 280 },
  "960x1200": { width: 960, height: 1200 },
  "320x100": { width: 320, height: 100 },
  "320x50": { width: 320, height: 50 },
  "300x1050": { width: 300, height: 1050 },
  "300x600": { width: 300, height: 600 },
  "160x600": { width: 160, height: 600 },
  "970x250": { width: 970, height: 250 },
  "728x90": { width: 728, height: 90 },
  "250x250": { width: 250, height: 250 },
};

const CTA_TRANSLATIONS: Record<string, Partial<Record<Language, string>>> = {
  "compare markets": {
    en: "Compare markets",
    fr: "Comparer les marches",
    it: "Confronta i mercati",
    nl: "Vergelijk markten",
    ar: "قارن الأسواق",
    he: "השווה שווקים",
  },
  "view tools": {
    en: "View tools",
    fr: "Voir les outils",
    it: "Vedi gli strumenti",
    nl: "Bekijk tools",
    ar: "اعرض الأدوات",
    he: "צפה בכלים",
  },
  "explore platform": {
    en: "Explore platform",
    fr: "Explorer la plateforme",
    it: "Scopri la piattaforma",
    nl: "Verken platform",
    ar: "استكشف المنصة",
    he: "חקור את הפלטפורמה",
  },
};

const TEXT_ROLES: TextRole[] = [
  "logo",
  "headline",
  "subheadline",
  "body",
  "cta",
  "disclaimer",
  "locked",
];

const sectionCls = "rounded-md border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950";
const labelCls = "text-xs font-medium uppercase tracking-wider text-zinc-500";
const textareaCls =
  "w-full rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900";
const buttonCls =
  "rounded border border-zinc-300 bg-white px-3 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800";
const primaryButtonCls =
  "rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50";

function guessTextRole(text: string): TextRole {
  const normalized = text.toLowerCase();
  if (normalized.includes("mexem") || normalized.includes("interactivebrokers")) {
    return "logo";
  }
  if (
    normalized.includes("risk") ||
    normalized.includes("loss") ||
    normalized.includes("caution") ||
    normalized.includes("attention") ||
    normalized.includes("investing involves") ||
    text.length > 110
  ) {
    return "disclaimer";
  }
  if (text.length <= 28 && /^(compare|view|explore|start|open|learn|trade)\b/i.test(text)) {
    return "cta";
  }
  return "body";
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function parseNumber(value: string | null): number | null {
  if (!value) return null;
  const match = value.match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function readBox(el: Element): Box | null {
  const x = parseNumber(el.getAttribute("x")) ?? 0;
  const y = parseNumber(el.getAttribute("y")) ?? 0;
  const width = parseNumber(el.getAttribute("width"));
  const height = parseNumber(el.getAttribute("height"));
  if (width === null || height === null || width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

function unionBoxes(boxes: Box[]): Box | null {
  if (boxes.length === 0) return null;
  const minX = Math.min(...boxes.map((box) => box.x));
  const minY = Math.min(...boxes.map((box) => box.y));
  const maxX = Math.max(...boxes.map((box) => box.x + box.width));
  const maxY = Math.max(...boxes.map((box) => box.y + box.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function clampBox(box: Box, viewBox: [number, number, number, number]): Box {
  const [sourceX, sourceY, sourceWidth, sourceHeight] = viewBox;
  const x = Math.max(sourceX, Math.min(box.x, sourceX + sourceWidth));
  const y = Math.max(sourceY, Math.min(box.y, sourceY + sourceHeight));
  const maxX = Math.max(x + 1, Math.min(box.x + box.width, sourceX + sourceWidth));
  const maxY = Math.max(y + 1, Math.min(box.y + box.height, sourceY + sourceHeight));
  return { x, y, width: maxX - x, height: maxY - y };
}

function expandBox(box: Box, padX: number, padY: number, viewBox: [number, number, number, number]): Box {
  return clampBox(
    {
      x: box.x - padX,
      y: box.y - padY,
      width: box.width + padX * 2,
      height: box.height + padY * 2,
    },
    viewBox,
  );
}

function isCanvasBackgroundRect(rect: Element, viewBox: [number, number, number, number]): boolean {
  const box = readBox(rect);
  if (!box) return false;
  const [sourceX, sourceY, sourceWidth, sourceHeight] = viewBox;
  const coversCanvas =
    box.x <= sourceX + 2 &&
    box.y <= sourceY + 2 &&
    box.x + box.width >= sourceX + sourceWidth - 2 &&
    box.y + box.height >= sourceY + sourceHeight - 2;
  const coversMostCanvas =
    box.width >= sourceWidth * 0.85 &&
    box.height >= sourceHeight * 0.7 &&
    box.y <= sourceY + sourceHeight * 0.12;
  return coversCanvas || coversMostCanvas;
}

function isInNonRenderingContainer(el: Element): boolean {
  let parent = el.parentElement;
  while (parent && parent.tagName.toLowerCase() !== "svg") {
    if (["clippath", "defs", "mask", "pattern", "symbol"].includes(parent.tagName.toLowerCase())) {
      return true;
    }
    parent = parent.parentElement;
  }
  return false;
}

function readStyleValue(el: Element, cssName: string): string | null {
  const value = (el as HTMLElement).style?.getPropertyValue(cssName);
  return value?.trim() || null;
}

function readSvgValue(el: Element, attr: string, cssName = attr): string | null {
  const candidates = [el, ...Array.from(el.querySelectorAll("tspan"))];
  for (const candidate of candidates) {
    const attrValue = candidate.getAttribute(attr);
    if (attrValue) return attrValue;
    const styleValue = readStyleValue(candidate, cssName);
    if (styleValue) return styleValue;
  }
  let parent = el.parentElement;
  while (parent && parent.tagName.toLowerCase() !== "svg") {
    const attrValue = parent.getAttribute(attr);
    if (attrValue) return attrValue;
    const styleValue = readStyleValue(parent, cssName);
    if (styleValue) return styleValue;
    parent = parent.parentElement;
  }
  return null;
}

function readTextCoordinate(el: Element, attr: "x" | "y"): number | null {
  const direct = parseNumber(el.getAttribute(attr));
  if (direct !== null) return direct;
  const firstTspan = el.querySelector("tspan");
  return firstTspan ? parseNumber(firstTspan.getAttribute(attr)) : null;
}

function multiplyMatrix(left: Matrix, right: Matrix): Matrix {
  return {
    a: left.a * right.a + left.c * right.b,
    b: left.b * right.a + left.d * right.b,
    c: left.a * right.c + left.c * right.d,
    d: left.b * right.c + left.d * right.d,
    e: left.a * right.e + left.c * right.f + left.e,
    f: left.b * right.e + left.d * right.f + left.f,
  };
}

function parseTransform(transform: string | null): Matrix {
  let matrix: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  if (!transform) return matrix;
  const commandRegex = /(\w+)\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = commandRegex.exec(transform)) !== null) {
    const params = match[2]
      .split(/[\s,]+/)
      .map(Number)
      .filter(Number.isFinite);
    let next: Matrix | null = null;
    if (match[1] === "matrix" && params.length >= 6) {
      next = { a: params[0], b: params[1], c: params[2], d: params[3], e: params[4], f: params[5] };
    } else if (match[1] === "translate") {
      next = { a: 1, b: 0, c: 0, d: 1, e: params[0] ?? 0, f: params[1] ?? 0 };
    } else if (match[1] === "scale") {
      next = { a: params[0] ?? 1, b: 0, c: 0, d: params[1] ?? params[0] ?? 1, e: 0, f: 0 };
    }
    if (next) matrix = multiplyMatrix(matrix, next);
  }
  return matrix;
}

function cumulativeTransform(el: Element): Matrix {
  const chain: Element[] = [];
  let node: Element | null = el;
  while (node && node.tagName.toLowerCase() !== "svg") {
    chain.unshift(node);
    node = node.parentElement;
  }
  return chain.reduce(
    (matrix, item) => multiplyMatrix(matrix, parseTransform(item.getAttribute("transform"))),
    { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
  );
}

function applyMatrix(matrix: Matrix, x: number, y: number): { x: number; y: number } {
  return {
    x: matrix.a * x + matrix.c * y + matrix.e,
    y: matrix.b * x + matrix.d * y + matrix.f,
  };
}

function parseFigmaSvg(svg: string): ParsedSvg | { error: string } {
  const source = svg.trim();
  if (!source) return { error: "Paste or upload an SVG exported from Figma." };
  const doc = new DOMParser().parseFromString(source, "image/svg+xml");
  const parserError = doc.querySelector("parsererror");
  if (parserError) return { error: normalizeText(parserError.textContent ?? "Invalid SVG.") };
  const root = doc.documentElement;
  if (root.tagName.toLowerCase() !== "svg") {
    return { error: "The source file must be an SVG." };
  }

  sanitizeSvg(root);
  const viewBoxAttr = root.getAttribute("viewBox");
  const viewBoxParts = viewBoxAttr?.split(/[\s,]+/).map(Number).filter(Number.isFinite) ?? [];
  const width = parseNumber(root.getAttribute("width")) ?? viewBoxParts[2] ?? 1200;
  const height = parseNumber(root.getAttribute("height")) ?? viewBoxParts[3] ?? 628;
  const viewBox: [number, number, number, number] =
    viewBoxParts.length === 4
      ? [viewBoxParts[0], viewBoxParts[1], viewBoxParts[2], viewBoxParts[3]]
      : [0, 0, width, height];

  const rawLayers = Array.from(root.querySelectorAll("text"))
    .map((el, index) => {
      const sourceText = normalizeText(el.textContent ?? "");
      const matrix = cumulativeTransform(el);
      const scale = Math.max(0.25, Math.hypot(matrix.a, matrix.b));
      const fontSize =
        (parseNumber(readSvgValue(el, "font-size", "font-size")) ?? 24) * scale;
      const rawX = readTextCoordinate(el, "x") ?? 0;
      const rawY = readTextCoordinate(el, "y") ?? fontSize;
      const point = applyMatrix(matrix, rawX, rawY);
      const textAnchor = readSvgValue(el, "text-anchor", "text-anchor") ?? "start";
      const width = Math.max(1, sourceText.length * fontSize * 0.58);
      return {
        index,
        sourceText,
        role: guessTextRole(sourceText),
        x: point.x,
        y: point.y,
        width,
        height: Math.max(1, fontSize * 1.15),
        fontSize,
        fontFamily: readSvgValue(el, "font-family", "font-family") ?? "Poppins",
        fontWeight: readSvgValue(el, "font-weight", "font-weight") ?? "700",
        fill: readSvgValue(el, "fill", "fill") ?? "#FFFFFF",
        textAnchor,
      };
    })
    .filter((layer) => layer.sourceText.length > 0);

  const ctaLayerIndexes = new Set(
    rawLayers
      .filter((layer) =>
        Array.from(root.querySelectorAll("rect")).some((rect) => {
          const x = parseNumber(rect.getAttribute("x")) ?? 0;
          const y = parseNumber(rect.getAttribute("y")) ?? 0;
          const w = parseNumber(rect.getAttribute("width")) ?? 0;
          const h = parseNumber(rect.getAttribute("height")) ?? 0;
          const isFullCanvas = w >= viewBox[2] * 0.75 && h >= viewBox[3] * 0.5;
          return !isFullCanvas && layer.x >= x && layer.x <= x + w && layer.y >= y && layer.y <= y + h;
        }),
      )
      .map((layer) => layer.index),
  );
  const copyCandidates = rawLayers
    .filter(
      (layer) =>
        layer.role !== "logo" &&
        layer.role !== "disclaimer" &&
        !ctaLayerIndexes.has(layer.index),
    )
    .sort((a, b) => b.fontSize - a.fontSize || a.y - b.y);
  const headlineIndex = copyCandidates[0]?.index;
  const subheadlineIndex = copyCandidates[1]?.index;
  const layers = rawLayers.map((layer) => {
    if (ctaLayerIndexes.has(layer.index)) return { ...layer, role: "cta" as const };
    if (layer.index === headlineIndex) return { ...layer, role: "headline" as const };
    if (layer.index === subheadlineIndex) return { ...layer, role: "subheadline" as const };
    return layer;
  });

  const artworkRoot = root.cloneNode(true) as Element;
  artworkRoot.querySelectorAll("text").forEach((el) => el.remove());
  const ctaLayers = layers.filter((layer) => layer.role === "cta");
  artworkRoot.querySelectorAll("rect").forEach((rect) => {
    const x = parseNumber(rect.getAttribute("x")) ?? 0;
    const y = parseNumber(rect.getAttribute("y")) ?? 0;
    const w = parseNumber(rect.getAttribute("width")) ?? 0;
    const h = parseNumber(rect.getAttribute("height")) ?? 0;
    const isFullCanvas = w >= viewBox[2] * 0.75 && h >= viewBox[3] * 0.5;
    const containsCtaText = ctaLayers.some(
      (layer) => layer.x >= x && layer.x <= x + w && layer.y >= y && layer.y <= y + h,
    );
    if (!isFullCanvas && containsCtaText) rect.remove();
  });

  const mode: SourceMode = layers.length > 0 ? "editable-text" : "outlined-vector";

  return {
    svg: new XMLSerializer().serializeToString(root),
    artworkInner: extractSvgInner(new XMLSerializer().serializeToString(artworkRoot)),
    sourceDefsInner: extractDefsInner(root),
    backgroundInner: extractBackgroundInner(root, viewBox),
    outlinedForegroundInner: buildOutlinedForegroundInner(root, viewBox),
    width,
    height,
    viewBox,
    layers,
    mode,
    outlinedSlices: mode === "outlined-vector" ? inferOutlinedSlices(root, viewBox) : [],
  };
}

function sanitizeSvg(root: Element): void {
  root.querySelectorAll("script, foreignObject, iframe, object, embed").forEach((el) => el.remove());
  root.querySelectorAll("*").forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim().toLowerCase();
      if (name.startsWith("on")) el.removeAttribute(attr.name);
      if ((name === "href" || name === "xlink:href") && value.startsWith("javascript:")) {
        el.removeAttribute(attr.name);
      }
    }
  });
}

function fitTransform(args: {
  sourceViewBox: [number, number, number, number];
  targetWidth: number;
  targetHeight: number;
  mode: FitMode;
}): string {
  const [, , sourceWidth, sourceHeight] = args.sourceViewBox;
  const scaleX = args.targetWidth / sourceWidth;
  const scaleY = args.targetHeight / sourceHeight;
  const scale = args.mode === "cover" ? Math.max(scaleX, scaleY) : Math.min(scaleX, scaleY);
  const x = (args.targetWidth - sourceWidth * scale) / 2;
  const y = (args.targetHeight - sourceHeight * scale) / 2;
  return `translate(${fmt(x)} ${fmt(y)}) scale(${fmt(scale)})`;
}

function fmt(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/\.?0+$/, "");
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function extractSvgInner(svg: string): string {
  const open = svg.match(/<svg\b[^>]*>/i);
  if (!open || open.index === undefined) return svg;
  const bodyStart = open.index + open[0].length;
  const bodyEnd = svg.lastIndexOf("</svg>");
  return bodyEnd > bodyStart ? svg.slice(bodyStart, bodyEnd).trim() : svg;
}

function extractDefsInner(root: Element): string {
  const serializer = new XMLSerializer();
  return Array.from(root.querySelectorAll("defs"))
    .flatMap((defs) => Array.from(defs.childNodes))
    .map((node) => serializer.serializeToString(node))
    .join("\n");
}

function extractBackgroundInner(root: Element, viewBox: [number, number, number, number]): string {
  const serializer = new XMLSerializer();
  const backgroundRects = Array.from(root.querySelectorAll("rect")).filter((rect) =>
    !isInNonRenderingContainer(rect) && isCanvasBackgroundRect(rect, viewBox),
  );
  return backgroundRects.map((rect) => serializer.serializeToString(rect)).join("\n");
}

function buildOutlinedForegroundInner(root: Element, viewBox: [number, number, number, number]): string {
  const foregroundRoot = root.cloneNode(true) as Element;
  foregroundRoot.querySelectorAll("defs").forEach((defs) => defs.remove());
  foregroundRoot.querySelectorAll("rect").forEach((rect) => {
    if (!isInNonRenderingContainer(rect) && isCanvasBackgroundRect(rect, viewBox)) rect.remove();
  });
  return extractSvgInner(new XMLSerializer().serializeToString(foregroundRoot));
}

function inferOutlinedSlices(root: Element, viewBox: [number, number, number, number]): OutlinedSlice[] {
  const [sourceX, sourceY, sourceWidth, sourceHeight] = viewBox;
  const relX = (value: number) => sourceX + sourceWidth * value;
  const relY = (value: number) => sourceY + sourceHeight * value;
  const generic = (x: number, y: number, width: number, height: number): Box =>
    clampBox({ x: relX(x), y: relY(y), width: sourceWidth * width, height: sourceHeight * height }, viewBox);
  const makeSlice = (id: string, role: OutlinedSliceRole, box: Box): OutlinedSlice => ({
    id,
    role,
    ...clampBox(box, viewBox),
  });

  const rectBoxes = Array.from(root.querySelectorAll("rect"))
    .filter((rect) => !isInNonRenderingContainer(rect) && !isCanvasBackgroundRect(rect, viewBox))
    .map(readBox)
    .filter((box): box is Box => Boolean(box));
  const filterBoxes = Array.from(root.querySelectorAll("filter"))
    .map(readBox)
    .filter((box): box is Box => Boolean(box));
  const maskBoxes = Array.from(root.querySelectorAll("mask"))
    .map(readBox)
    .filter((box): box is Box => Boolean(box));

  const brandBox =
    unionBoxes(
      maskBoxes.filter(
        (box) =>
          box.y >= sourceY &&
          box.y <= relY(0.2) &&
          box.width <= sourceWidth * 0.18 &&
          box.height <= sourceHeight * 0.08,
      ),
    ) ?? generic(0.18, 0.055, 0.64, 0.1);

  const headlineBox =
    unionBoxes(
      filterBoxes.filter(
        (box) =>
          box.y >= relY(0.12) &&
          box.y <= relY(0.48) &&
          box.width >= sourceWidth * 0.35 &&
          box.height <= sourceHeight * 0.16,
      ),
    ) ?? generic(0.055, 0.185, 0.89, 0.24);

  const ctaBox =
    rectBoxes
      .filter(
        (box) =>
          box.width >= sourceWidth * 0.16 &&
          box.width <= sourceWidth * 0.68 &&
          box.height >= sourceHeight * 0.025 &&
          box.height <= sourceHeight * 0.095 &&
          box.y >= relY(0.32) &&
          box.y <= relY(0.62),
      )
      .sort((a, b) => Math.abs(a.y - (headlineBox.y + headlineBox.height)) - Math.abs(b.y - (headlineBox.y + headlineBox.height)))[0] ??
    generic(0.3, 0.43, 0.4, 0.075);

  const visualBox =
    rectBoxes
      .filter(
        (box) =>
          box.y >= relY(0.45) &&
          box.width >= sourceWidth * 0.2 &&
          box.height >= sourceHeight * 0.15,
      )
      .sort((a, b) => b.width * b.height - a.width * a.height)[0] ??
    generic(0.12, 0.55, 0.76, 0.42);

  const disclaimerBox = generic(
    0.05,
    Math.min(0.74, (ctaBox.y + ctaBox.height - sourceY) / sourceHeight + 0.02),
    0.9,
    0.09,
  );

  return [
    makeSlice("brand", "brand", expandBox(brandBox, sourceWidth * 0.18, sourceHeight * 0.035, viewBox)),
    makeSlice("headline", "headline", expandBox(headlineBox, sourceWidth * 0.035, sourceHeight * 0.012, viewBox)),
    makeSlice("cta", "cta", expandBox(ctaBox, sourceWidth * 0.035, sourceHeight * 0.02, viewBox)),
    makeSlice("disclaimer", "disclaimer", disclaimerBox),
    makeSlice("visual", "visual", expandBox(visualBox, sourceWidth * 0.04, sourceHeight * 0.025, viewBox)),
  ];
}

function translatedTextForLayer(args: {
  layer: TextLayer;
  language: Language;
  translations: Record<number, Partial<Record<Language, string>>>;
  roles: Record<number, TextRole>;
  disclaimersByLanguage: Partial<Record<Language, string>>;
  defaultDisclaimer: string;
}): { text: string; role: TextRole; warnings: string[] } {
  const role = args.roles[args.layer.index] ?? args.layer.role;
  const warnings: string[] = [];
  let text = args.layer.sourceText;

  if (role === "disclaimer") {
    text =
      args.disclaimersByLanguage[args.language] ??
      (args.language === "en" ? args.defaultDisclaimer : "") ??
      args.layer.sourceText;
    if (!text) {
      warnings.push(`${LANG_META[args.language].englishName}: disclaimer is missing.`);
      text = args.layer.sourceText;
    }
  } else if (role !== "locked" && role !== "logo") {
    text = args.translations[args.layer.index]?.[args.language]?.trim() || args.layer.sourceText;
    if (args.language !== "en" && text === args.layer.sourceText) {
      const preset = CTA_TRANSLATIONS[args.layer.sourceText.toLowerCase()]?.[args.language];
      if (preset) text = preset;
    }
    if (args.language !== "en" && text === args.layer.sourceText) {
      warnings.push(`${LANG_META[args.language].englishName}: "${args.layer.sourceText}" still uses English.`);
    }
  }

  return { text, role, warnings };
}

function wrapText(text: string, maxChars: number): string[] {
  const clean = normalizeText(text);
  if (clean.length <= maxChars) return [clean];
  const words = clean.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function fitFontSize(text: string, width: number, maxFont: number, minFont: number, maxLines: number): number {
  let fontSize = maxFont;
  while (fontSize > minFont) {
    const charsPerLine = Math.max(4, Math.floor(width / Math.max(1, fontSize * 0.56)));
    if (wrapText(text, charsPerLine).length <= maxLines) return fontSize;
    fontSize -= 1;
  }
  return minFont;
}

function renderEditableText(args: {
  text: string;
  x: number;
  y: number;
  width: number;
  fontSize: number;
  lineHeight: number;
  fill: string;
  fontFamily: string;
  fontWeight: string;
  anchor?: "start" | "middle" | "end";
  rtl?: boolean;
  role: TextRole;
}): string {
  const maxChars = Math.max(4, Math.floor(args.width / Math.max(1, args.fontSize * 0.56)));
  const lines = wrapText(args.text, maxChars);
  const directionAttrs = args.rtl ? ` direction="rtl" unicode-bidi="plaintext"` : "";
  const anchor = args.anchor ?? "start";
  const tspans = lines
    .map((line, index) => {
      const dy = index === 0 ? "0" : fmt(args.fontSize * args.lineHeight);
      return `<tspan x="${fmt(args.x)}" dy="${dy}">${escapeAttr(line)}</tspan>`;
    })
    .join("");
  return `<text x="${fmt(args.x)}" y="${fmt(args.y)}" data-text-role="${args.role}" font-family="${escapeAttr(args.fontFamily)}" font-size="${fmt(args.fontSize)}" font-weight="${escapeAttr(args.fontWeight)}" fill="${escapeAttr(args.fill)}" text-anchor="${anchor}" xml:space="preserve"${directionAttrs}>${tspans}</text>`;
}

function textHeight(text: string, width: number, fontSize: number, lineHeight: number): number {
  const maxChars = Math.max(4, Math.floor(width / Math.max(1, fontSize * 0.56)));
  return wrapText(text, maxChars).length * fontSize * lineHeight;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function findOutlinedSlice(slices: OutlinedSlice[], role: OutlinedSliceRole): OutlinedSlice | null {
  return slices.find((slice) => slice.role === role) ?? null;
}

function outlinedPlacements(parsed: ParsedSvg, size: { width: number; height: number }): OutlinedPlacement[] {
  const margin = Math.max(6, Math.round(Math.min(size.width, size.height) * (size.height <= 110 ? 0.08 : 0.075)));
  const gap = Math.max(5, Math.round(Math.min(size.width, size.height) * 0.035));
  const aspect = size.width / size.height;
  const micro = size.height <= 110;
  const compact = size.height <= 60;
  const wideShort = aspect >= 2.8;
  const landscape = aspect >= 1.45;
  const narrow = size.width <= 180;
  const placements: OutlinedPlacement[] = [];

  const add = (
    role: OutlinedSliceRole,
    box: Box,
    preserveAspectRatio: "xMidYMid meet" | "xMidYMid slice" = "xMidYMid meet",
  ) => {
    const slice = findOutlinedSlice(parsed.outlinedSlices, role);
    if (!slice || box.width <= 2 || box.height <= 2) return;
    placements.push({
      slice,
      preserveAspectRatio,
      x: Math.round(box.x),
      y: Math.round(box.y),
      width: Math.round(box.width),
      height: Math.round(box.height),
    });
  };

  if (micro || wideShort) {
    const ctaW = clamp(size.width * (compact ? 0.25 : 0.23), 58, size.width * 0.28);
    const brandW = clamp(size.width * (compact ? 0.18 : 0.2), 46, size.width * 0.24);
    const ctaH = clamp(size.height * (compact ? 0.5 : 0.46), 18, size.height - margin * 2);
    add("brand", {
      x: margin,
      y: margin,
      width: brandW,
      height: size.height - margin * 2,
    });
    add("headline", {
      x: margin + brandW + gap,
      y: margin,
      width: Math.max(30, size.width - margin * 3 - gap * 2 - brandW - ctaW),
      height: size.height - margin * 2,
    });
    add("cta", {
      x: size.width - margin - ctaW,
      y: (size.height - ctaH) / 2,
      width: ctaW,
      height: ctaH,
    });
    return placements;
  }

  if (landscape) {
    const copyW = size.width * 0.52;
    const visualX = size.width * 0.57;
    const brandH = clamp(size.height * 0.14, 34, 92);
    const ctaH = clamp(size.height * 0.11, 34, 76);
    const discH = size.height >= 210 ? clamp(size.height * 0.085, 24, 58) : 0;
    const headlineY = margin + brandH + gap;
    const headlineH = Math.max(56, size.height - headlineY - ctaH - discH - margin - gap * 3);
    add("brand", { x: margin, y: margin, width: copyW * 0.82, height: brandH });
    add("headline", { x: margin, y: headlineY, width: copyW, height: headlineH });
    add("cta", {
      x: margin,
      y: headlineY + headlineH + gap,
      width: clamp(copyW * 0.48, 150, 360),
      height: ctaH,
    });
    if (discH > 0) {
      add("disclaimer", {
        x: margin,
        y: size.height - margin - discH,
        width: copyW,
        height: discH,
      });
    }
    add(
      "visual",
      {
        x: visualX,
        y: margin,
        width: size.width - visualX - margin,
        height: size.height - margin * 2,
      },
      "xMidYMid slice",
    );
    return placements;
  }

  if (narrow) {
    let y = margin;
    const brandH = clamp(size.height * 0.09, 34, 60);
    const headlineH = clamp(size.height * 0.25, 108, 160);
    const ctaH = clamp(size.height * 0.08, 34, 54);
    const discH = clamp(size.height * 0.1, 46, 74);
    add("brand", { x: margin, y, width: size.width - margin * 2, height: brandH });
    y += brandH + gap * 1.5;
    add("headline", { x: margin, y, width: size.width - margin * 2, height: headlineH });
    y += headlineH + gap;
    add("cta", { x: margin * 1.25, y, width: size.width - margin * 2.5, height: ctaH });
    y += ctaH + gap;
    add("disclaimer", { x: margin, y, width: size.width - margin * 2, height: discH });
    y += discH + gap;
    add(
      "visual",
      { x: margin, y, width: size.width - margin * 2, height: Math.max(0, size.height - y - margin) },
      "xMidYMid slice",
    );
    return placements;
  }

  let cursorY = margin;
  const brandH = clamp(size.height * 0.095, 34, 140);
  const headlineH = clamp(size.height * 0.25, 70, 430);
  const ctaH = clamp(size.height * 0.055, 28, 92);
  const discH = size.height >= 180 ? clamp(size.height * 0.055, 26, 96) : 0;
  add("brand", {
    x: margin,
    y: cursorY,
    width: size.width - margin * 2,
    height: brandH,
  });
  cursorY += brandH + gap;
  add("headline", {
    x: margin,
    y: cursorY,
    width: size.width - margin * 2,
    height: headlineH,
  });
  cursorY += headlineH + gap;
  add("cta", {
    x: size.width * 0.22,
    y: cursorY,
    width: size.width * 0.56,
    height: ctaH,
  });
  cursorY += ctaH + gap;
  if (discH > 0) {
    add("disclaimer", {
      x: margin,
      y: cursorY,
      width: size.width - margin * 2,
      height: discH,
    });
    cursorY += discH + gap;
  }
  const visualHeight = size.height - cursorY - margin;
  if (visualHeight >= Math.max(34, size.height * 0.13)) {
    add(
      "visual",
      {
        x: margin,
        y: cursorY,
        width: size.width - margin * 2,
        height: visualHeight,
      },
      "xMidYMid slice",
    );
  }
  return placements;
}

function sliceClipId(baseClipId: string, placement: OutlinedPlacement, index: number): string {
  return `${baseClipId}_${placement.slice.role}_${index}`;
}

function sliceSourceClipId(baseClipId: string, placement: OutlinedPlacement, index: number): string {
  return `${sliceClipId(baseClipId, placement, index)}_source`;
}

function renderOutlinedSlice(args: {
  placement: OutlinedPlacement;
  foregroundId: string;
  targetClipId: string;
  sourceClipId: string;
}): string {
  const { placement, foregroundId, targetClipId, sourceClipId } = args;
  const { slice } = placement;
  const scaleX = placement.width / slice.width;
  const scaleY = placement.height / slice.height;
  const scale =
    placement.preserveAspectRatio === "xMidYMid slice"
      ? Math.max(scaleX, scaleY)
      : Math.min(scaleX, scaleY);
  const drawWidth = slice.width * scale;
  const drawHeight = slice.height * scale;
  const drawX = placement.x + (placement.width - drawWidth) / 2;
  const drawY = placement.y + (placement.height - drawHeight) / 2;
  const transform = `translate(${fmt(drawX)} ${fmt(drawY)}) scale(${fmt(scale)}) translate(${fmt(-slice.x)} ${fmt(-slice.y)})`;
  return `<g data-layer-role="outlined-slice" data-slice-role="${slice.role}" data-slice-x="${fmt(placement.x)}" data-slice-y="${fmt(placement.y)}" data-slice-width="${fmt(placement.width)}" data-slice-height="${fmt(placement.height)}" clip-path="url(#${targetClipId})"><g clip-path="url(#${sourceClipId})" transform="${transform}"><use href="#${foregroundId}"/></g></g>`;
}

function buildOutlinedVariantSvg(args: {
  parsed: ParsedSvg;
  format: CampaignFormat;
  language: Language;
  canvasFill: string;
}): VariantSvg {
  const size = FORMAT_SIZE[args.format];
  const [sourceX, sourceY, sourceWidth, sourceHeight] = args.parsed.viewBox;
  const suffix = `${args.format}_${args.language}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  const clipId = `outlined_clip_${suffix}`;
  const backgroundId = `outlined_background_${suffix}`;
  const foregroundId = `outlined_foreground_${suffix}`;
  const backgroundTransform = fitTransform({
    sourceViewBox: args.parsed.viewBox,
    targetWidth: size.width,
    targetHeight: size.height,
    mode: "cover",
  });
  const placements = outlinedPlacements(args.parsed, size);
  const backgroundLayer = args.parsed.backgroundInner.trim()
    ? [
        `  <defs>`,
        args.parsed.sourceDefsInner,
        `    <g id="${backgroundId}">`,
        args.parsed.backgroundInner,
        `    </g>`,
        `    <g id="${foregroundId}">`,
        args.parsed.outlinedForegroundInner,
        `    </g>`,
        `    <clipPath id="${clipId}"><rect x="0" y="0" width="${size.width}" height="${size.height}"/></clipPath>`,
        ...placements.map(
          (placement, index) =>
            `    <clipPath id="${sliceClipId(clipId, placement, index)}" clipPathUnits="userSpaceOnUse"><rect x="${fmt(placement.x)}" y="${fmt(placement.y)}" width="${fmt(placement.width)}" height="${fmt(placement.height)}"/></clipPath>`,
        ),
        ...placements.map(
          (placement, index) =>
            `    <clipPath id="${sliceSourceClipId(clipId, placement, index)}" clipPathUnits="userSpaceOnUse"><rect x="${fmt(placement.slice.x)}" y="${fmt(placement.slice.y)}" width="${fmt(placement.slice.width)}" height="${fmt(placement.slice.height)}"/></clipPath>`,
        ),
        `  </defs>`,
      ]
    : [
        `  <defs>`,
        args.parsed.sourceDefsInner,
        `    <g id="${foregroundId}">`,
        args.parsed.outlinedForegroundInner,
        `    </g>`,
        `    <clipPath id="${clipId}"><rect x="0" y="0" width="${size.width}" height="${size.height}"/></clipPath>`,
        ...placements.map(
          (placement, index) =>
            `    <clipPath id="${sliceClipId(clipId, placement, index)}" clipPathUnits="userSpaceOnUse"><rect x="${fmt(placement.x)}" y="${fmt(placement.y)}" width="${fmt(placement.width)}" height="${fmt(placement.height)}"/></clipPath>`,
        ),
        ...placements.map(
          (placement, index) =>
            `    <clipPath id="${sliceSourceClipId(clipId, placement, index)}" clipPathUnits="userSpaceOnUse"><rect x="${fmt(placement.slice.x)}" y="${fmt(placement.slice.y)}" width="${fmt(placement.slice.width)}" height="${fmt(placement.slice.height)}"/></clipPath>`,
        ),
        `  </defs>`,
      ];

  const svg = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${size.width} ${size.height}" width="${size.width}" height="${size.height}" data-source="figma-adapter" data-format="${args.format}" data-language="${args.language}" data-layout-mode="outlined-vector">`,
    ...backgroundLayer,
    `  <rect x="0" y="0" width="${size.width}" height="${size.height}" fill="${escapeAttr(args.canvasFill)}"/>`,
    `  <g clip-path="url(#${clipId})">`,
    args.parsed.backgroundInner.trim()
      ? `    <g transform="${backgroundTransform} translate(${-sourceX} ${-sourceY})" data-layer-role="source-background" data-source-viewbox="${sourceX} ${sourceY} ${sourceWidth} ${sourceHeight}"><use href="#${backgroundId}"/></g>`
      : "",
    `    <g data-layer-role="outlined-layout">`,
    ...placements.map(
      (placement, index) =>
        `      ${renderOutlinedSlice({
          placement,
          foregroundId,
          targetClipId: sliceClipId(clipId, placement, index),
          sourceClipId: sliceSourceClipId(clipId, placement, index),
        })}`,
    ),
    `    </g>`,
    `  </g>`,
    `</svg>`,
  ].filter(Boolean).join("\n");

  return {
    key: `${args.language}_${args.format}`,
    language: args.language,
    format: args.format,
    width: size.width,
    height: size.height,
    svg,
    warnings: [],
  };
}

function buildVariantSvg(args: {
  parsed: ParsedSvg;
  format: CampaignFormat;
  language: Language;
  fitMode: FitMode;
  translations: Record<number, Partial<Record<Language, string>>>;
  roles: Record<number, TextRole>;
  disclaimersByLanguage: Partial<Record<Language, string>>;
  defaultDisclaimer: string;
  canvasFill: string;
}): VariantSvg {
  if (args.parsed.mode === "outlined-vector") {
    return buildOutlinedVariantSvg({
      parsed: args.parsed,
      format: args.format,
      language: args.language,
      canvasFill: args.canvasFill,
    });
  }

  const size = FORMAT_SIZE[args.format];
  const [sourceX, sourceY, sourceWidth, sourceHeight] = args.parsed.viewBox;
  const transform = fitTransform({
    sourceViewBox: args.parsed.viewBox,
    targetWidth: size.width,
    targetHeight: size.height,
    mode: args.fitMode,
  });
  const clipId = `clip_${args.format.replace("x", "_")}_${args.language}`;
  const rtl = LANG_META[args.language].rtl;
  const margin = Math.max(8, Math.round(Math.min(size.width, size.height) * (size.height <= 100 ? 0.06 : 0.075)));
  const aspect = size.width / size.height;
  const micro = size.height <= 110;
  const compact = size.height <= 60;
  const landscape = aspect >= 1.45;
  const narrow = size.width <= 180;
  const languageScale = rtl ? 0.92 : 1;

  const localizedLayers = args.parsed.layers.map((layer) => ({
    layer,
    ...translatedTextForLayer({
      layer,
      language: args.language,
      translations: args.translations,
      roles: args.roles,
      disclaimersByLanguage: args.disclaimersByLanguage,
      defaultDisclaimer: args.defaultDisclaimer,
    }),
  }));
  const warnings = localizedLayers.flatMap((item) => item.warnings);
  const pick = (role: TextRole) =>
    localizedLayers
      .filter((item) => item.role === role)
      .sort((a, b) => a.layer.y - b.layer.y);
  const logo = pick("logo")[0];
  const headline = pick("headline")[0] ?? pick("body")[0];
  const subheadline = pick("subheadline")[0];
  const body = pick("body").find((item) => item.layer.index !== headline?.layer.index);
  const cta = pick("cta")[0];
  const disclaimer = pick("disclaimer")[0];
  const plannedCtaH = cta
    ? micro
      ? compact
        ? Math.max(14, Math.round(size.height * 0.42))
        : Math.max(16, Math.round(size.height * 0.36))
      : Math.max(34, Math.min(76, Math.round(size.height * 0.085)))
    : 0;
  const plannedCtaW = cta
    ? micro
      ? compact
        ? Math.max(64, Math.min(Math.round(size.width * 0.26), 92))
        : Math.max(58, Math.min(Math.round(size.width * 0.3), 128))
      : Math.max(120, Math.min(Math.round(size.width * (landscape ? 0.32 : 0.58)), 390))
    : 0;
  const plannedCtaX = cta
    ? micro
      ? size.width - margin - plannedCtaW
      : landscape
        ? margin
        : Math.round((size.width - plannedCtaW) / 2)
    : size.width;

  const contentWidth = micro
    ? Math.max(40, plannedCtaX - Math.round(size.width * (compact ? 0.2 : 0.23)) - margin)
    : landscape
      ? Math.round(size.width * 0.5)
      : size.width - margin * 2;
  const contentX = micro
    ? Math.round(size.width * (compact ? 0.2 : 0.23))
    : landscape
      ? margin
      : margin;
  const centerX = size.width / 2;
  let cursorY = margin;
  const textPieces: string[] = [];

  if (logo) {
    const logoFont = micro
      ? Math.max(8, Math.min(compact ? 12 : 18, size.height * 0.22))
      : Math.max(16, Math.min(46, size.height * 0.08, size.width * 0.09));
    const logoX = micro ? margin : landscape ? margin : centerX;
    const logoAnchor = micro || landscape ? "start" : "middle";
    const logoY = margin + logoFont;
    textPieces.push(renderEditableText({
      text: logo.text,
      x: logoX,
      y: logoY,
      width: micro ? Math.round(size.width * 0.2) : contentWidth,
      fontSize: logoFont,
      lineHeight: 1,
      fill: logo.layer.fill,
      fontFamily: logo.layer.fontFamily,
      fontWeight: logo.layer.fontWeight,
      anchor: logoAnchor,
      rtl,
      role: "logo",
    }));
    cursorY = logoY + Math.max(8, logoFont * (micro ? 0.4 : 0.9));
  }

  if (headline) {
    const maxHeadline = micro
      ? Math.max(8, Math.min(22, size.height * 0.32))
      : Math.max(20, Math.min(78, size.height * 0.13, size.width * (landscape ? 0.07 : 0.1)));
    const headlineFont = fitFontSize(headline.text, contentWidth, maxHeadline * languageScale, micro ? 7 : 14, micro ? 1 : narrow ? 4 : 3);
    const headlineX = micro || landscape ? contentX : centerX;
    const headlineAnchor = micro || landscape ? "start" : "middle";
    const headlineY = micro ? Math.round(size.height * (compact ? 0.62 : 0.56)) : cursorY + headlineFont;
    textPieces.push(renderEditableText({
      text: headline.text,
      x: headlineX,
      y: headlineY,
      width: contentWidth,
      fontSize: headlineFont,
      lineHeight: 1.03,
      fill: headline.layer.fill,
      fontFamily: headline.layer.fontFamily,
      fontWeight: headline.layer.fontWeight,
      anchor: headlineAnchor,
      rtl,
      role: "headline",
    }));
    cursorY = headlineY + textHeight(headline.text, contentWidth, headlineFont, 1.03) + (micro ? 4 : Math.max(16, headlineFont * 0.28));
  }

  if (!micro && subheadline) {
    const subFont = fitFontSize(subheadline.text, contentWidth, Math.max(14, Math.min(42, size.height * 0.07)), 10, 2);
    textPieces.push(renderEditableText({
      text: subheadline.text,
      x: landscape ? contentX : centerX,
      y: cursorY + subFont,
      width: contentWidth,
      fontSize: subFont * languageScale,
      lineHeight: 1.14,
      fill: subheadline.layer.fill,
      fontFamily: subheadline.layer.fontFamily,
      fontWeight: subheadline.layer.fontWeight,
      anchor: landscape ? "start" : "middle",
      rtl,
      role: "subheadline",
    }));
    cursorY += textHeight(subheadline.text, contentWidth, subFont, 1.14) + 10;
  }

  if (!micro && !narrow && body) {
    const bodyFont = fitFontSize(body.text, contentWidth, Math.max(12, Math.min(28, size.height * 0.045)), 9, 2);
    textPieces.push(renderEditableText({
      text: body.text,
      x: landscape ? contentX : centerX,
      y: cursorY + bodyFont,
      width: contentWidth,
      fontSize: bodyFont * languageScale,
      lineHeight: 1.18,
      fill: body.layer.fill,
      fontFamily: body.layer.fontFamily,
      fontWeight: body.layer.fontWeight,
      anchor: landscape ? "start" : "middle",
      rtl,
      role: "body",
    }));
    cursorY += textHeight(body.text, contentWidth, bodyFont, 1.18) + 12;
  }

  if (cta) {
    const ctaH = plannedCtaH;
    const ctaW = plannedCtaW;
    const ctaX = plannedCtaX;
    const ctaY = micro
      ? Math.round((size.height - ctaH) / 2)
      : Math.min(size.height - margin - ctaH - (disclaimer ? Math.max(12, size.height * 0.055) : 0), Math.max(cursorY, size.height - margin - ctaH - Math.max(28, size.height * 0.12)));
    const ctaFont = fitFontSize(cta.text, ctaW - 24, Math.max(11, Math.min(30, ctaH * 0.42)), 7, 1);
    textPieces.push(`<rect x="${fmt(ctaX)}" y="${fmt(ctaY)}" width="${fmt(ctaW)}" height="${fmt(ctaH)}" rx="${fmt(ctaH / 2)}" fill="#FFFFFF" data-layer-role="cta-background"/>`);
    textPieces.push(renderEditableText({
      text: cta.text,
      x: ctaX + ctaW / 2,
      y: ctaY + ctaH / 2 + ctaFont * 0.35,
      width: ctaW - 24,
      fontSize: ctaFont,
      lineHeight: 1,
      fill: "#0A0F1F",
      fontFamily: cta.layer.fontFamily,
      fontWeight: "800",
      anchor: "middle",
      rtl,
      role: "cta",
    }));
  }

  if (disclaimer) {
    const discWidth = micro ? Math.max(60, contentWidth) : size.width - margin * 2;
    const discFont = micro
      ? Math.max(5, Math.min(8, size.height * 0.1))
      : narrow
        ? Math.max(6, Math.min(10, size.width * 0.055, size.height * 0.022))
        : Math.max(8, Math.min(18, size.height * 0.028));
    const discLineHeight = 1.05;
    const scaledDiscFont = discFont * languageScale;
    const discHeight = textHeight(disclaimer.text, discWidth, scaledDiscFont, discLineHeight);
    const discY = size.height - margin - Math.max(0, discHeight - scaledDiscFont);
    textPieces.push(renderEditableText({
      text: disclaimer.text,
      x: landscape || micro ? margin : centerX,
      y: discY,
      width: discWidth,
      fontSize: scaledDiscFont,
      lineHeight: discLineHeight,
      fill: disclaimer.layer.fill,
      fontFamily: disclaimer.layer.fontFamily,
      fontWeight: disclaimer.layer.fontWeight,
      anchor: landscape || micro ? "start" : "middle",
      rtl,
      role: "disclaimer",
    }));
  }

  const svg = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${size.width} ${size.height}" width="${size.width}" height="${size.height}" data-source="figma-adapter" data-format="${args.format}" data-language="${args.language}">`,
    `  <defs><clipPath id="${clipId}"><rect x="0" y="0" width="${size.width}" height="${size.height}"/></clipPath></defs>`,
    `  <rect x="0" y="0" width="${size.width}" height="${size.height}" fill="${escapeAttr(args.canvasFill)}"/>`,
    `  <g clip-path="url(#${clipId})">`,
    `    <g transform="${transform} translate(${-sourceX} ${-sourceY})" data-layer-role="source-artwork" data-source-viewbox="${sourceX} ${sourceY} ${sourceWidth} ${sourceHeight}">`,
    args.parsed.artworkInner,
    `    </g>`,
    `    <g data-layer-role="adaptive-layout">`,
    ...textPieces.map((piece) => `      ${piece}`),
    `    </g>`,
    `  </g>`,
    `</svg>`,
  ].join("\n");

  return {
    key: `${args.language}_${args.format}`,
    language: args.language,
    format: args.format,
    width: size.width,
    height: size.height,
    svg,
    warnings,
  };
}

function prefixSvgIds(svg: string, prefix: string): string {
  const ids = new Set<string>();
  const idRegex = /\bid=(["'])([^"']+)\1/g;
  let match: RegExpExecArray | null;
  while ((match = idRegex.exec(svg)) !== null) ids.add(match[2]);
  let out = svg;
  for (const id of ids) {
    const nextId = `${prefix}${id}`;
    out = out.replace(
      new RegExp(`\\bid=(["'])${escapeRegExp(id)}\\1`, "g"),
      (_match, quote: string) => `id=${quote}${nextId}${quote}`,
    );
    out = out.replace(new RegExp(`url\\(#${escapeRegExp(id)}\\)`, "g"), `url(#${nextId})`);
    out = out.replace(
      new RegExp(`href=(["'])#${escapeRegExp(id)}\\1`, "g"),
      (_match, quote: string) => `href=${quote}#${nextId}${quote}`,
    );
    out = out.replace(
      new RegExp(`xlink:href=(["'])#${escapeRegExp(id)}\\1`, "g"),
      (_match, quote: string) => `xlink:href=${quote}#${nextId}${quote}`,
    );
  }
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildCombinedSvg(variants: VariantSvg[]): string {
  const gap = 72;
  const labelHeight = 36;
  const columns = Math.min(3, Math.max(1, Math.ceil(Math.sqrt(variants.length))));
  const rows: VariantSvg[][] = [];
  for (let i = 0; i < variants.length; i += columns) {
    rows.push(variants.slice(i, i + columns));
  }
  const colWidths = Array.from({ length: columns }, (_, col) =>
    Math.max(...rows.map((row) => row[col]?.width ?? 0), 0),
  );
  const rowHeights = rows.map((row) => Math.max(...row.map((item) => item.height), 0));
  const width = colWidths.reduce((sum, value) => sum + value, 0) + gap * Math.max(0, columns + 1);
  const height =
    rowHeights.reduce((sum, value) => sum + value + labelHeight, 0) +
    gap * Math.max(0, rows.length + 1);
  const pieces: string[] = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" data-source="figma-adapter-combined">`,
    `<rect width="${width}" height="${height}" fill="#F4F4F5"/>`,
  ];
  let y = gap;
  rows.forEach((row, rowIndex) => {
    let x = gap;
    row.forEach((variant, colIndex) => {
      pieces.push(
        `<text x="${x}" y="${y}" font-family="Inter, Arial, sans-serif" font-size="18" font-weight="700" fill="#18181B">${escapeAttr(variant.language.toUpperCase())} · ${escapeAttr(variant.format)}</text>`,
      );
      pieces.push(
        `<svg x="${x}" y="${y + labelHeight}" width="${variant.width}" height="${variant.height}" viewBox="0 0 ${variant.width} ${variant.height}" overflow="visible">`,
      );
      pieces.push(prefixSvgIds(extractSvgInner(variant.svg), `v${rowIndex}_${colIndex}_`));
      pieces.push(`</svg>`);
      x += colWidths[colIndex] + gap;
    });
    y += rowHeights[rowIndex] + labelHeight + gap;
  });
  pieces.push(`</svg>`);
  return pieces.join("\n") + "\n";
}

function downloadTextFile(filename: string, text: string, type = "image/svg+xml;charset=utf-8") {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function statusBoxCls(kind: "neutral" | "success" | "error"): string {
  if (kind === "error") {
    return "rounded border border-red-300 bg-red-50 p-2 text-xs text-red-800 dark:border-red-700 dark:bg-red-950/40 dark:text-red-200";
  }
  if (kind === "success") {
    return "rounded border border-emerald-300 bg-emerald-50 p-2 text-xs text-emerald-800 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-200";
  }
  return "rounded border border-zinc-200 bg-zinc-50 p-2 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300";
}

function initTranslations(layers: TextLayer[], props: Props): Record<number, Partial<Record<Language, string>>> {
  const next: Record<number, Partial<Record<Language, string>>> = {};
  for (const layer of layers) {
    const values: Partial<Record<Language, string>> = { en: layer.sourceText };
    for (const language of LANGUAGES) {
      if (layer.role === "disclaimer") {
        values[language] =
          props.disclaimersByLanguage[language] ??
          (language === "en" ? props.defaultDisclaimer : undefined) ??
          layer.sourceText;
        continue;
      }
      const preset = CTA_TRANSLATIONS[layer.sourceText.toLowerCase()]?.[language];
      values[language] = preset ?? layer.sourceText;
    }
    next[layer.index] = values;
  }
  return next;
}

export function FigmaAdapterClient(props: Props) {
  const [sourceSvg, setSourceSvg] = useState("");
  const [selectedFormats, setSelectedFormats] = useState<CampaignFormat[]>(ALL_CAMPAIGN_FORMATS);
  const [selectedLanguages, setSelectedLanguages] = useState<Language[]>([...LANGUAGES]);
  const [fitMode, setFitMode] = useState<FitMode>("contain");
  const [canvasFill, setCanvasFill] = useState("#00122C");
  const [roles, setRoles] = useState<Record<number, TextRole>>({});
  const [translations, setTranslations] = useState<Record<number, Partial<Record<Language, string>>>>({});
  const [campaignName, setCampaignName] = useState("Figma Adapter Campaign");
  const [translationStatus, setTranslationStatus] = useState<{
    state: TranslationStatus;
    message: string;
  }>({ state: "idle", message: "" });
  const [saveStatus, setSaveStatus] = useState<{
    state: SaveStatus;
    message: string;
    href?: string;
  }>({ state: "idle", message: "" });

  const parsed = useMemo(() => parseFigmaSvg(sourceSvg), [sourceSvg]);
  const parsedSvg = "error" in parsed ? null : parsed;
  const parseError = "error" in parsed ? parsed.error : null;

  const variants = useMemo(() => {
    if (!parsedSvg) return [];
    return selectedLanguages.flatMap((language) =>
      selectedFormats.map((format) =>
        buildVariantSvg({
          parsed: parsedSvg,
          format,
          language,
          fitMode,
          translations,
          roles,
          disclaimersByLanguage: props.disclaimersByLanguage,
          defaultDisclaimer: props.defaultDisclaimer,
          canvasFill,
        }),
      ),
    );
  }, [
    canvasFill,
    fitMode,
    parsedSvg,
    props.defaultDisclaimer,
    props.disclaimersByLanguage,
    roles,
    selectedFormats,
    selectedLanguages,
    translations,
  ]);

  const sourceWarnings =
    parsedSvg?.mode === "outlined-vector"
      ? [
          "Source SVG has no editable text nodes. Outlined vector fallback can re-layout the artwork, but automatic translation needs a Figma/SVG export with live text.",
        ]
      : [];
  const warnings = [
    ...sourceWarnings,
    ...variants.flatMap((variant) =>
      variant.warnings.map((warning) => `${variant.language}/${variant.format}: ${warning}`),
    ),
  ];

  function toggleFormat(format: CampaignFormat) {
    setSelectedFormats((current) =>
      current.includes(format)
        ? current.length === 1
          ? current
          : current.filter((item) => item !== format)
        : [...current, format],
    );
  }

  function toggleLanguage(language: Language) {
    setSelectedLanguages((current) =>
      current.includes(language)
        ? current.length === 1
          ? current
          : current.filter((item) => item !== language)
        : [...current, language],
    );
  }

  function updateSourceSvg(nextSvg: string) {
    setSourceSvg(nextSvg);
    setTranslationStatus({ state: "idle", message: "" });
    setSaveStatus({ state: "idle", message: "" });
    const nextParsed = parseFigmaSvg(nextSvg);
    if ("error" in nextParsed) return;
    setRoles(Object.fromEntries(nextParsed.layers.map((layer) => [layer.index, layer.role])));
    setTranslations(initTranslations(nextParsed.layers, props));
  }

  async function autoTranslateLayers() {
    if (!parsedSvg) return;
    const layers = parsedSvg.layers
      .map((layer) => ({
        index: layer.index,
        text: layer.sourceText,
        role: roles[layer.index] ?? layer.role,
      }))
      .filter((layer) => !["logo", "locked", "disclaimer"].includes(layer.role));
    if (layers.length === 0) {
      setTranslationStatus({
        state: "done",
        message: "No translatable text layers were found.",
      });
      return;
    }

    setTranslationStatus({
      state: "running",
      message: "Translating extracted text layers...",
    });
    try {
      const res = await fetch("/api/figma-adapter/translate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          layers,
          languages: selectedLanguages,
        }),
      });
      const json = (await res.json().catch(() => null)) as
        | {
            ok?: boolean;
            translations?: Record<string, Partial<Record<Language, string>>>;
            message?: string;
          }
        | null;
      if (!res.ok || !json?.ok || !json.translations) {
        throw new Error(json?.message ?? "Auto-translation failed.");
      }
      setTranslations((current) => {
        const next = { ...current };
        for (const [indexKey, values] of Object.entries(json.translations ?? {})) {
          const index = Number(indexKey);
          if (!Number.isFinite(index)) continue;
          next[index] = {
            ...(next[index] ?? {}),
            ...values,
          };
        }
        return next;
      });
      setTranslationStatus({
        state: "done",
        message: `Translated ${layers.length} extracted text layer${layers.length === 1 ? "" : "s"}.`,
      });
      setSaveStatus({ state: "idle", message: "" });
    } catch (err) {
      setTranslationStatus({
        state: "error",
        message: (err as Error).message,
      });
    }
  }

  async function saveCampaignToHistory() {
    if (!parsedSvg || variants.length === 0) return;
    setSaveStatus({ state: "saving", message: "Saving campaign to history..." });
    try {
      const res = await fetch("/api/figma-adapter/save-campaign", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          campaign_name: campaignName,
          source_summary: {
            width: parsedSvg.width,
            height: parsedSvg.height,
            text_layer_count: parsedSvg.layers.length,
          },
          formats: selectedFormats,
          languages: selectedLanguages,
          variants,
          warnings,
        }),
      });
      const json = (await res.json().catch(() => null)) as
        | {
            ok?: boolean;
            campaign_id?: string;
            href?: string;
            message?: string;
          }
        | null;
      if (!res.ok || !json?.ok || !json.campaign_id || !json.href) {
        throw new Error(json?.message ?? "Saving campaign failed.");
      }
      setSaveStatus({
        state: "done",
        message: `Saved to campaign history as ${json.campaign_id}.`,
        href: json.href,
      });
    } catch (err) {
      setSaveStatus({
        state: "error",
        message: (err as Error).message,
      });
    }
  }

  async function downloadZip() {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    for (const variant of variants) {
      zip.file(`${variant.language}/${variant.format}.svg`, variant.svg);
    }
    zip.file("all-banners.svg", buildCombinedSvg(variants));
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "figma-adapter-banners.zip";
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-5">
      <section className={`${sectionCls} space-y-3`}>
        <h2 className="text-sm font-semibold">Source Figma SVG</h2>
        <div className="grid gap-3 sm:grid-cols-[240px_1fr]">
          <div className="space-y-2">
            <label className="block">
              <span className={labelCls}>upload SVG</span>
              <input
                type="file"
                accept=".svg,image/svg+xml"
                className="mt-2 block w-full text-xs"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  updateSourceSvg(await file.text());
                }}
              />
            </label>
            {parsedSvg && (
              <div className="rounded border border-zinc-200 bg-zinc-50 p-2 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
                Source: {fmt(parsedSvg.width)} x {fmt(parsedSvg.height)} · {parsedSvg.layers.length} text layers
                {parsedSvg.mode === "outlined-vector"
                  ? ` · outlined fallback (${parsedSvg.outlinedSlices.length} slices)`
                  : ""}
              </div>
            )}
            {parseError && sourceSvg.trim().length > 0 && (
              <div className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
                {parseError}
              </div>
            )}
          </div>
          <textarea
            value={sourceSvg}
            onChange={(e) => updateSourceSvg(e.target.value)}
            rows={8}
            className={`${textareaCls} font-mono text-xs`}
            placeholder="<svg ...>Paste the SVG exported from Figma here</svg>"
          />
        </div>
      </section>

      {parsedSvg && (
        <>
          <section className={`${sectionCls} space-y-3`}>
            <h2 className="text-sm font-semibold">Generation setup</h2>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <label className="space-y-2">
                <span className={labelCls}>fit mode</span>
                <select
                  value={fitMode}
                  onChange={(e) => setFitMode(e.target.value as FitMode)}
                  className={textareaCls}
                >
                  <option value="contain">contain - preserve full design</option>
                  <option value="cover">cover - fill canvas, crop edges</option>
                </select>
              </label>
              <label className="space-y-2">
                <span className={labelCls}>canvas fill</span>
                <div className="flex gap-2">
                  <input
                    type="color"
                    value={/^#[0-9a-fA-F]{6}$/.test(canvasFill) ? canvasFill : "#00122C"}
                    onChange={(e) => setCanvasFill(e.target.value.toUpperCase())}
                    className="h-9 w-12 rounded border border-zinc-300 dark:border-zinc-700"
                  />
                  <input
                    value={canvasFill}
                    onChange={(e) => setCanvasFill(e.target.value)}
                    className={textareaCls}
                  />
                </div>
              </label>
              <label className="space-y-2">
                <span className={labelCls}>campaign name</span>
                <input
                  value={campaignName}
                  onChange={(e) => setCampaignName(e.target.value)}
                  className={textareaCls}
                />
              </label>
              <div className="space-y-2">
                <span className={labelCls}>output</span>
                <div className="rounded border border-zinc-200 bg-zinc-50 p-2 text-sm text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
                  <div>{variants.length} editable SVG variants</div>
                  <div className="mt-0.5 text-xs text-zinc-500">
                    {selectedLanguages.length} language{selectedLanguages.length === 1 ? "" : "s"} ·{" "}
                    {selectedFormats.length} format{selectedFormats.length === 1 ? "" : "s"}
                  </div>
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <div className={labelCls}>formats</div>
              <div className="flex flex-wrap gap-2">
                {ALL_CAMPAIGN_FORMATS.map((format) => (
                  <label
                    key={format}
                    className={pillCls(selectedFormats.includes(format))}
                  >
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={selectedFormats.includes(format)}
                      onChange={() => toggleFormat(format)}
                    />
                    {format}
                  </label>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <div className={labelCls}>languages</div>
              <div className="flex flex-wrap gap-2">
                {LANGUAGES.map((language) => (
                  <label
                    key={language}
                    className={pillCls(selectedLanguages.includes(language))}
                  >
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={selectedLanguages.includes(language)}
                      onChange={() => toggleLanguage(language)}
                    />
                    {LANG_META[language].nativeName}
                  </label>
                ))}
              </div>
            </div>
          </section>

          <section className={`${sectionCls} space-y-3`}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-sm font-semibold">Extracted text layers</h2>
              <button
                type="button"
                className={primaryButtonCls}
                onClick={autoTranslateLayers}
                disabled={translationStatus.state === "running"}
              >
                {translationStatus.state === "running" ? "Translating..." : "Auto-translate layers"}
              </button>
            </div>
            {translationStatus.message && (
              <div
                className={statusBoxCls(
                  translationStatus.state === "error"
                    ? "error"
                    : translationStatus.state === "done"
                      ? "success"
                      : "neutral",
                )}
              >
                {translationStatus.message}
              </div>
            )}
            <div className="space-y-3">
              {parsedSvg.layers.map((layer) => (
                <div
                  key={layer.index}
                  className="grid gap-3 rounded border border-zinc-200 p-3 dark:border-zinc-800 lg:grid-cols-[180px_1fr]"
                >
                  <div className="space-y-2">
                    <div className="text-xs font-mono text-zinc-500">text_{layer.index + 1}</div>
                    <select
                      value={roles[layer.index] ?? layer.role}
                      onChange={(e) =>
                        setRoles((current) => ({
                          ...current,
                          [layer.index]: e.target.value as TextRole,
                        }))
                      }
                      className={textareaCls}
                    >
                      {TEXT_ROLES.map((role) => (
                        <option key={role} value={role}>
                          {role}
                        </option>
                      ))}
                    </select>
                    <p className="text-xs text-zinc-500">{layer.sourceText}</p>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {LANGUAGES.map((language) => (
                      <label key={language} className="space-y-1">
                        <span className={labelCls}>{LANG_META[language].nativeName}</span>
                        <textarea
                          value={translations[layer.index]?.[language] ?? ""}
                          disabled={
                            (roles[layer.index] ?? layer.role) === "locked" ||
                            (roles[layer.index] ?? layer.role) === "logo"
                          }
                          onChange={(e) =>
                            setTranslations((current) => ({
                              ...current,
                              [layer.index]: {
                                ...(current[layer.index] ?? {}),
                                [language]: e.target.value,
                              },
                            }))
                          }
                          rows={2}
                          className={textareaCls}
                        />
                      </label>
                    ))}
                  </div>
                </div>
              ))}
              {parsedSvg.layers.length === 0 && (
                <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
                  No editable SVG text nodes were found, so this source is being adapted as outlined vectors.
                  Layout export still works, but translation requires exporting the banner from Figma with live text.
                </div>
              )}
            </div>
          </section>

          <section className={`${sectionCls} space-y-3`}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold">Output SVGs</h2>
                <p className="mt-1 text-xs text-zinc-500">
                  Download immediately or save this set into campaign history.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={buttonCls}
                  onClick={() => downloadTextFile("figma-adapter-all-banners.svg", buildCombinedSvg(variants))}
                  disabled={variants.length === 0}
                >
                  Download combined SVG
                </button>
                <button
                  type="button"
                  className={primaryButtonCls}
                  onClick={downloadZip}
                  disabled={variants.length === 0}
                >
                  Download ZIP
                </button>
                <button
                  type="button"
                  className={primaryButtonCls}
                  onClick={saveCampaignToHistory}
                  disabled={variants.length === 0 || saveStatus.state === "saving"}
                >
                  {saveStatus.state === "saving" ? "Saving..." : "Save to campaign history"}
                </button>
              </div>
            </div>
            {saveStatus.message && (
              <div className={statusBoxCls(saveStatus.state === "error" ? "error" : "success")}>
                {saveStatus.message}{" "}
                {saveStatus.href && (
                  <>
                    <Link className="font-medium underline" href={saveStatus.href}>
                      Open campaign
                    </Link>
                    {" · "}
                    <Link className="font-medium underline" href="/campaigns">
                      View history
                    </Link>
                  </>
                )}
              </div>
            )}
            {warnings.length > 0 && (
              <div className="max-h-36 overflow-auto rounded border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
                {warnings.slice(0, 40).map((warning) => (
                  <div key={warning}>{warning}</div>
                ))}
                {warnings.length > 40 && <div>+ {warnings.length - 40} more warnings</div>}
              </div>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              {variants.slice(0, 12).map((variant) => (
                <div
                  key={variant.key}
                  className="space-y-2 rounded border border-zinc-200 p-3 dark:border-zinc-800"
                >
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-medium">
                      {LANG_META[variant.language].nativeName} · {variant.format}
                    </span>
                    <button
                      type="button"
                      className={buttonCls}
                      onClick={() => downloadTextFile(`${variant.language}-${variant.format}.svg`, variant.svg)}
                    >
                      SVG
                    </button>
                  </div>
                  <div
                    className="overflow-hidden rounded border border-zinc-200 bg-zinc-100 [&>svg]:h-full [&>svg]:w-full dark:border-zinc-800 dark:bg-zinc-900"
                    style={{ aspectRatio: `${variant.width} / ${variant.height}` }}
                    dangerouslySetInnerHTML={{ __html: variant.svg }}
                  />
                </div>
              ))}
            </div>
            {variants.length > 12 && (
              <p className="text-xs text-zinc-500">
                Showing 12 previews. Downloads include all {variants.length} generated SVGs.
              </p>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function pillCls(active: boolean): string {
  return [
    "inline-flex cursor-pointer items-center rounded-full border px-3 py-1 text-xs transition",
    active
      ? "border-blue-600 bg-blue-50 text-blue-700 dark:border-blue-400 dark:bg-blue-950/40 dark:text-blue-200"
      : "border-zinc-300 text-zinc-600 hover:border-zinc-500 dark:border-zinc-700 dark:text-zinc-300",
  ].join(" ");
}
