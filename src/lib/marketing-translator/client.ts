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
 * When MARKETING_TRANSLATOR_API_URL is unset, the call falls through to
 * the local mock so dev work doesn't depend on the translator running.
 */

import {
  CampaignCopyRequestSchema,
  CampaignCopyBatchRequestSchema,
  CampaignCopyBatchResponseSchema,
  CampaignCopyByMessageRequestSchema,
  CampaignCopyByMessageResponseSchema,
  LocalizedCopyPackageSchema,
  type CampaignCopyRequest,
  type CampaignCopyBatchRequest,
  type CampaignCopyBatchResponse,
  type CampaignCopyByMessageRequest,
  type CampaignCopyByMessageResponse,
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

export async function fetchCampaignCopy(
  request: CampaignCopyRequest,
  opts: FetchCampaignCopyOptions = {},
): Promise<LocalizedCopyPackage> {
  const validated = CampaignCopyRequestSchema.parse(request);
  const baseUrl = opts.baseUrl ?? process.env.MARKETING_TRANSLATOR_API_URL;
  const apiKey = opts.apiKey ?? process.env.MARKETING_TRANSLATOR_API_KEY;

  if (!baseUrl) {
    // Production guard: the deterministic mock is a dev convenience. If the
    // translator URL is unset in production it means the integration was
    // misconfigured at deploy time; we must fail loudly rather than silently
    // emit "[mock <locale>] …" copy into live campaigns.
    if (process.env.NODE_ENV === "production") {
      throw new MarketingTranslatorError(
        500,
        "MARKETING_TRANSLATOR_API_URL is required in production. Refusing to use the deterministic mock client.",
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
): Promise<CampaignCopyBatchResponse> {
  const validated = CampaignCopyBatchRequestSchema.parse(request);
  const baseUrl = opts.baseUrl ?? process.env.MARKETING_TRANSLATOR_API_URL;
  const apiKey = opts.apiKey ?? process.env.MARKETING_TRANSLATOR_API_KEY;

  if (!baseUrl) {
    if (process.env.NODE_ENV === "production") {
      throw new MarketingTranslatorError(
        500,
        "MARKETING_TRANSLATOR_API_URL is required in production. Refusing to use the deterministic mock client.",
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
  const parsed = CampaignCopyBatchResponseSchema.safeParse(json);
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

export async function fetchCampaignCopyByMessage(
  request: CampaignCopyByMessageRequest,
  opts: FetchCampaignCopyOptions = {},
): Promise<CampaignCopyByMessageResponse> {
  const validated = CampaignCopyByMessageRequestSchema.parse(request);
  const baseUrl = opts.baseUrl ?? process.env.MARKETING_TRANSLATOR_API_URL;
  const apiKey = opts.apiKey ?? process.env.MARKETING_TRANSLATOR_API_KEY;

  if (!baseUrl) {
    // No mock for by-message; if URL is unset in production, fail loudly.
    if (process.env.NODE_ENV === "production") {
      throw new MarketingTranslatorError(
        500,
        "MARKETING_TRANSLATOR_API_URL is required in production. Refusing to use the deterministic mock client.",
      );
    }
    // Dev convenience: fall back to the batch mock (same shape, deterministic).
    return mockCampaignCopyBatch({
      brief: validated.brief,
      targetLocale: validated.targetLocale,
      tone: validated.tone,
      riskWarningRequired: validated.riskWarningRequired,
      concepts: Array.from({ length: validated.conceptCount ?? 3 }, (_, i) => ({
        conceptId: `concept_${i + 1}`,
      })),
    });
  }

  const url = new URL("/api/campaign-copy/by-message", baseUrl).toString();
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
  const parsed = CampaignCopyByMessageResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new MarketingTranslatorError(
      502,
      `marketing-translator by-message response failed schema: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}
