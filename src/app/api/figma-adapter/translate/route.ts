import { NextResponse } from "next/server";
import { z } from "zod";
import { LANG_META, LANGUAGES, LanguageSchema } from "@/lib/i18n/language";

const TextRoleSchema = z.enum([
  "logo",
  "headline",
  "subheadline",
  "body",
  "cta",
  "disclaimer",
  "locked",
]);

const RequestSchema = z.object({
  layers: z
    .array(
      z.object({
        index: z.number().int().min(0),
        text: z.string().trim().min(1).max(300),
        role: TextRoleSchema,
      }),
    )
    .min(1)
    .max(20),
  languages: z.array(LanguageSchema).min(1).max(LANGUAGES.length),
});

const ResponseSchema = z.object({
  translations: z.record(z.string(), z.record(z.string(), z.string().min(1).max(320))),
});

export const maxDuration = 90;

export async function POST(request: Request) {
  const json = await request.json().catch(() => null);
  const parsed = RequestSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "invalid_request", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const translatableLayers = parsed.data.layers.filter(
    (layer) => !["logo", "locked", "disclaimer"].includes(layer.role),
  );
  if (translatableLayers.length === 0) {
    return NextResponse.json({ ok: true, translations: {}, source: "none" });
  }

  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json(
      {
        ok: false,
        error: "missing_openai_key",
        message: "OPENAI_API_KEY is required to auto-translate extracted Figma text layers.",
      },
      { status: 500 },
    );
  }

  try {
    const OpenAI = (await import("openai")).default;
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const model =
      process.env.FIGMA_ADAPTER_TRANSLATION_MODEL ??
      process.env.OPENAI_MODEL ??
      "gpt-4o-mini";
    const targetLanguages = parsed.data.languages.map((language) => ({
      code: language,
      name: LANG_META[language].englishName,
      rtl: LANG_META[language].rtl,
    }));

    const completion = await client.chat.completions.create({
      model,
      response_format: { type: "json_object" },
      temperature: 0.2,
      max_tokens: 3000,
      messages: [
        {
          role: "system",
          content:
            "You translate approved financial advertising banner text. Return compact JSON only. Preserve brand names, product names, numbers, legal meaning, punctuation style, and line intent. Keep CTAs short. Do not add claims, emojis, explanations, or markdown. Do not translate logo, locked, or disclaimer layers.",
        },
        {
          role: "user",
          content: JSON.stringify({
            output_contract:
              "Return {\"translations\":{\"<layer index>\":{\"<language code>\":\"translated text\"}}}. Include every requested language for every layer. English can stay identical unless a source typo needs no correction.",
            languages: targetLanguages,
            layers: translatableLayers,
          }),
        },
      ],
    });

    const raw = completion.choices[0]?.message?.content ?? "{}";
    const parsedResponse = ResponseSchema.safeParse(JSON.parse(raw));
    if (!parsedResponse.success) {
      return NextResponse.json(
        {
          ok: false,
          error: "invalid_ai_response",
          issues: parsedResponse.error.issues,
        },
        { status: 502 },
      );
    }

    const translations: Record<string, Partial<Record<LanguageSchemaOutput, string>>> = {};
    for (const layer of translatableLayers) {
      const layerTranslations = parsedResponse.data.translations[String(layer.index)] ?? {};
      translations[String(layer.index)] = {};
      for (const language of parsed.data.languages) {
        const value = layerTranslations[language]?.trim();
        if (value) translations[String(layer.index)][language] = value;
      }
    }

    return NextResponse.json({
      ok: true,
      source: "openai",
      translations,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: "translation_failed",
        message: redact((err as Error).message),
      },
      { status: 500 },
    );
  }
}

type LanguageSchemaOutput = z.infer<typeof LanguageSchema>;

function redact(s: string): string {
  return s
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/api_key=[^&\s)]*/gi, "api_key=[redacted]")
    .replace(/sk-[A-Za-z0-9._-]{8,}/g, "sk-[redacted]");
}
