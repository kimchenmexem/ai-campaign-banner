/**
 * Server-side HTTP client for marketing-translator's /api/campaign-copy.
 *
 * marketing-translator is the single source of campaign / ad copy.
 * ai-campaign-banner does NOT generate headline / subheadline / cta /
 * disclaimer locally; it calls this client and writes the result into
 * each concept's copy_package before manifest construction.
 *
 * Auth: sends `Authorization: Bearer ${MARKETING_TRANSLATOR_API_KEY}`.
 * The translator side accepts that as a static service-to-service token
 * via its CAMPAIGN_COPY_API_KEY.
 *
 * Mock fallback (dev only):
 *   When MARKETING_TRANSLATOR_API_URL is unset AND NODE_ENV !== "production",
 *   the call falls through to a local deterministic mock so dev work doesn't
 *   depend on the translator running. In production the missing URL is a
 *   hard error; the mock fallback only re-enables when the operator
 *   explicitly opts in via MARKETING_TRANSLATOR_ALLOW_MOCK=1. This prevents
 *   "[mock] ..." copy from silently shipping in real campaigns.
 */

import {
  CampaignCopyBatchRequestSchema,
  CampaignCopyRequestSchema,
  LocalizedCopyBatchResponseSchema,
  LocalizedCopyPackageSchema,
  type CampaignCopyBatchRequest,
  type CampaignCopyRequest,
  type LocalizedCopyBatchResponse,
  type LocalizedCopyPackage,
} from "@/lib/marketing-translator/schema";
import {
  mockCampaignCopy,
  mockCampaignCopyBatch,
} from "@/lib/marketing-translator/mock";

export interface FetchCampaignCopyOptions {
  signal?: AbortSignal;
  /** Override the URL/key (tests). Otherwise read from env. */
  baseUrl?: string;
  apiKey?: string;
}

export class MarketingTranslatorError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "MarketingTranslatorError";
  }
}

export class MarketingTranslatorConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketingTranslatorConfigError";
  }
}

export async function fetchCampaignCopy(
  request: CampaignCopyRequest,
  opts: FetchCampaignCopyOptions = {},
): Promise<LocalizedCopyPackage> {
  const validated = CampaignCopyRequestSchema.parse(request);
  const baseUrl = opts.baseUrl ?? process.env.MARKETING_TRANSLATOR_API_URL;
  const apiKey = opts.apiKey ?? process.env.MARKETING_TRANSLATOR_API_KEY;

  if (!baseUrl) {
    const isProduction = process.env.NODE_ENV === "production";
    const allowMock = process.env.MARKETING_TRANSLATOR_ALLOW_MOCK === "1";
    if (isProduction && !allowMock) {
      throw new MarketingTranslatorConfigError(
        "MARKETING_TRANSLATOR_API_URL is required in production. " +
          "Set the env var to the translator service URL, or (for an " +
          "intentional staging dry-run only) set " +
          "MARKETING_TRANSLATOR_ALLOW_MOCK=1 to re-enable the local mock.",
      );
    }
    return mockCampaignCopy(validated);
  }

  const url = new URL("/api/campaign-copy", baseUrl).toString();
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(validated),
    signal: opts.signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new MarketingTranslatorError(
      res.status,
      `marketing-translator ${res.status}: ${redact(text).slice(0, 500)}`,
    );
  }

  const json = (await res.json()) as unknown;
  const parsed = LocalizedCopyPackageSchema.safeParse(json);
  if (!parsed.success) {
    throw new MarketingTranslatorError(
      502,
      `marketing-translator response failed schema: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

export async function fetchCampaignCopyBatch(
  request: CampaignCopyBatchRequest,
  opts: FetchCampaignCopyOptions = {},
): Promise<LocalizedCopyBatchResponse> {
  const validated = CampaignCopyBatchRequestSchema.parse(request);
  const baseUrl = opts.baseUrl ?? process.env.MARKETING_TRANSLATOR_API_URL;
  const apiKey = opts.apiKey ?? process.env.MARKETING_TRANSLATOR_API_KEY;

  if (!baseUrl) {
    const isProduction = process.env.NODE_ENV === "production";
    const allowMock = process.env.MARKETING_TRANSLATOR_ALLOW_MOCK === "1";
    if (isProduction && !allowMock) {
      throw new MarketingTranslatorConfigError(
        "MARKETING_TRANSLATOR_API_URL is required in production. " +
          "Set the env var to the translator service URL, or (for an " +
          "intentional staging dry-run only) set " +
          "MARKETING_TRANSLATOR_ALLOW_MOCK=1 to re-enable the local mock.",
      );
    }
    return mockCampaignCopyBatch(validated);
  }

  const url = new URL("/api/campaign-copy/batch", baseUrl).toString();
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(validated),
    signal: opts.signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new MarketingTranslatorError(
      res.status,
      `marketing-translator ${res.status}: ${redact(text).slice(0, 500)}`,
    );
  }

  const json = (await res.json()) as unknown;
  const parsed = LocalizedCopyBatchResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new MarketingTranslatorError(
      502,
      `marketing-translator batch response failed schema: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

function redact(s: string): string {
  return s
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9._-]{8,}/g, "sk-[redacted]");
}
