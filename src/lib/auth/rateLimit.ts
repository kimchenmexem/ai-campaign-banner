import "server-only";
import { NextResponse } from "next/server";
import type { AuthSession } from "@/lib/auth/session";

// ─────────────────────────────────────────────────────────────────────────────
// In-process token-bucket rate limiter.
//
// Suitable for single-instance deployments (the same machine that handles
// every request) AND for protecting expensive routes (Playwright, AI calls,
// uploads) from accidental loops or runaway scripts on a single instance.
//
// Multi-instance production should swap this for a Redis-backed limiter; the
// interface (`enforceRateLimit`) stays the same so the swap is local.
// ─────────────────────────────────────────────────────────────────────────────

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  // Used to namespace bucket keys so /render and /export don't share counters.
  scope: string;
}

function keyFor(request: Request, scope: string, session: AuthSession | null): string {
  if (session) return `${scope}:user:${session.user_id}`;
  // Anonymous fallback (e.g. login attempts) — best-effort by forwarded IP.
  const fwd =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "anon";
  return `${scope}:ip:${fwd}`;
}

export function enforceRateLimit(
  request: Request,
  opts: RateLimitOptions,
  session: AuthSession | null = null,
): NextResponse | null {
  const k = keyFor(request, opts.scope, session);
  const now = Date.now();
  let b = buckets.get(k);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + opts.windowMs };
    buckets.set(k, b);
  }
  b.count += 1;
  if (b.count > opts.max) {
    const retryAfter = Math.max(1, Math.ceil((b.resetAt - now) / 1000));
    return NextResponse.json(
      { ok: false, error: "rate_limited", retry_after_seconds: retryAfter },
      {
        status: 429,
        headers: {
          "Retry-After": String(retryAfter),
        },
      },
    );
  }
  return null;
}

// Public presets so route handlers don't sprinkle magic numbers.
export const RATE_LIMITS = {
  // Heavy AI / Playwright / export operations.
  expensive: { windowMs: 60_000, max: 10, scope: "expensive" as const },
  // Image / asset uploads.
  upload: { windowMs: 60_000, max: 30, scope: "upload" as const },
  // Generic mutating writes (PATCH/POST against repository state).
  write: { windowMs: 60_000, max: 60, scope: "write" as const },
} as const;

// Tests sometimes need to reset buckets between cases.
export function _resetRateLimits(): void {
  buckets.clear();
}
