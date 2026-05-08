// ─────────────────────────────────────────────────────────────────────────────
// Bannerbear client — server-side HTTP wrapper.
//
// Bannerbear is the renderer only. Nothing here drives schema decisions; the
// Element Manifest does. These helpers exist so `renderAd.ts` and
// `syncTemplate.ts` can call the API without re-implementing auth, polling,
// and error redaction.
//
// API key is read lazily via `getBannerbearAuthHeaders()` so the app boots
// with an empty `.env.local` but any caller fails fast with a clear message.
// The key is never logged; errors are scrubbed before being thrown.
// ─────────────────────────────────────────────────────────────────────────────

const BANNERBEAR_BASE_URL = "https://api.bannerbear.com/v2";
const DEFAULT_POLL_INTERVAL_MS = 1500;
const DEFAULT_POLL_MAX_ATTEMPTS = 30; // ~45s max before giving up

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

export interface BannerbearEnvStatus {
  api_key_present: boolean;
  template_1200x628_present: boolean;
  template_1080x1080_present: boolean;
  template_1080x1920_present: boolean;
}

/**
 * Snapshot of which Bannerbear env vars are set. Returns presence-only flags
 * — the API key value is never returned.
 */
export function bannerbearEnvStatus(): BannerbearEnvStatus {
  return {
    api_key_present: !!process.env.BANNERBEAR_API_KEY,
    template_1200x628_present: hasNonPlaceholder("BANNERBEAR_TEMPLATE_1200x628"),
    template_1080x1080_present: hasNonPlaceholder("BANNERBEAR_TEMPLATE_1080x1080"),
    template_1080x1920_present: hasNonPlaceholder("BANNERBEAR_TEMPLATE_1080x1920"),
  };
}

function hasNonPlaceholder(key: string): boolean {
  const v = process.env[key];
  return !!v && !v.startsWith("REPLACE_WITH");
}

export function getBannerbearAuthHeaders(): { Authorization: string } {
  const apiKey = requireEnv("BANNERBEAR_API_KEY");
  return { Authorization: `Bearer ${apiKey}` };
}

// ── Generic request ──────────────────────────────────────────────────────────
export interface BannerbearRequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  signal?: AbortSignal;
}

export async function bannerbearRequest<T = unknown>(
  path: string,
  opts: BannerbearRequestOptions = {},
): Promise<T> {
  const url = new URL(BANNERBEAR_BASE_URL + path);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    ...getBannerbearAuthHeaders(),
  };
  const res = await fetch(url.toString(), {
    method: opts.method ?? "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Bannerbear ${res.status} ${res.statusText} on ${opts.method ?? "GET"} ${path}: ${redact(text)}`,
    );
  }
  return (await res.json()) as T;
}

// ── Templates ────────────────────────────────────────────────────────────────
export interface BannerbearTemplateResponse {
  uid: string;
  name: string;
  width: number;
  height: number;
  available_modifications?: Array<Record<string, unknown>>;
  // Bannerbear extends with arbitrary fields — keep open.
  [k: string]: unknown;
}

/**
 * GET /v2/templates/:uid (with `extended=true` by default to include
 * available_modifications). Returns the raw Bannerbear shape; the caller
 * decides which fields to persist.
 */
export async function getBannerbearTemplate(
  templateUid: string,
  extended: boolean = true,
): Promise<BannerbearTemplateResponse> {
  return bannerbearRequest<BannerbearTemplateResponse>(`/templates/${templateUid}`, {
    method: "GET",
    query: { extended },
  });
}

// ── Image render ─────────────────────────────────────────────────────────────
export interface BannerbearImageCreatePayload {
  template: string;
  modifications: Array<Record<string, unknown>>;
  // Optional metadata we attach for later debugging.
  metadata?: string;
  webhook_url?: string;
  // `synchronous: true` blocks until rendered. We default to async + poll so
  // we get a stable timeout behavior.
  synchronous?: boolean;
}

export interface BannerbearImageResponse {
  uid: string;
  status: "pending" | "completed" | "failed" | string;
  image_url?: string | null;
  image_url_png?: string | null;
  image_url_jpg?: string | null;
  template?: string;
  width?: number;
  height?: number;
  created_at?: string;
  metadata?: string;
  modifications?: Array<Record<string, unknown>>;
  // Catch-all
  [k: string]: unknown;
}

export async function createBannerbearImage(
  payload: BannerbearImageCreatePayload,
): Promise<BannerbearImageResponse> {
  return bannerbearRequest<BannerbearImageResponse>(`/images`, {
    method: "POST",
    body: payload,
  });
}

export async function getBannerbearImage(
  imageUid: string,
): Promise<BannerbearImageResponse> {
  return bannerbearRequest<BannerbearImageResponse>(`/images/${imageUid}`);
}

export interface PollOptions {
  intervalMs?: number;
  maxAttempts?: number;
  signal?: AbortSignal;
}

export interface PollResult {
  finalResponse: BannerbearImageResponse;
  attempts: number;
  elapsedMs: number;
}

/**
 * Poll GET /v2/images/:uid until status === "completed" or "failed", or
 * until maxAttempts is reached. Returns the final response either way.
 *
 * Bannerbear renders typically complete in 5-15s; max 30 attempts × 1500ms
 * = 45s before we surface a timeout error.
 */
export async function pollBannerbearImage(
  imageUid: string,
  opts: PollOptions = {},
): Promise<PollResult> {
  const interval = opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_POLL_MAX_ATTEMPTS;
  const start = Date.now();

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (opts.signal?.aborted) {
      throw new Error("pollBannerbearImage aborted");
    }
    const r = await getBannerbearImage(imageUid);
    if (r.status === "completed" || r.status === "failed") {
      return { finalResponse: r, attempts: attempt, elapsedMs: Date.now() - start };
    }
    await sleep(interval, opts.signal);
  }
  throw new Error(
    `pollBannerbearImage(${imageUid}): timed out after ${maxAttempts} attempts (${(maxAttempts * interval) / 1000}s).`,
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

// ── Legacy compat: keep getBannerbearClient() so existing callers compile ───
// (`renderAd.ts` and `syncTemplate.ts` reference it before this rewrite.)
export interface BannerbearClient {
  fetch<T>(path: string, init?: RequestInit): Promise<T>;
}
export function getBannerbearClient(): BannerbearClient {
  return {
    async fetch<T>(path: string, init?: RequestInit): Promise<T> {
      const res = await fetch(`${BANNERBEAR_BASE_URL}${path}`, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          ...getBannerbearAuthHeaders(),
          ...(init?.headers ?? {}),
        },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Bannerbear ${res.status} on ${path}: ${redact(body)}`);
      }
      return (await res.json()) as T;
    },
  };
}

// ── Error redaction ──────────────────────────────────────────────────────────
const SECRET_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._-]+/g,
  /api_key=[^&\s)]*/gi,
];
function redact(msg: string): string {
  let out = msg;
  for (const re of SECRET_PATTERNS) out = out.replace(re, (m) => m.split(/[\s=]/)[0] + " [redacted]");
  return out;
}
