// ─────────────────────────────────────────────────────────────────────────────
// Language metadata for the campaign generator.
//
// Each supported language carries the four pieces of information the
// pipeline cares about:
//   1. rtl              — whether layout / text-align / CTA arrow flips
//   2. charWidthRatio   — used by fitFontToBox; varies by script
//   3. fontStack        — CSS font-family list with script-appropriate
//                          fallbacks. Loaded via Google Fonts in the
//                          /render/ad/[adId] page.
//   4. arrow            — direction-appropriate Unicode arrow for the CTA
//                          ("→" in LTR, "←" in RTL, conventionally read
//                          as "next" / "forward")
//
// Add new languages by appending to LANGUAGES + LANG_META. The schema and
// form pick up new options automatically.
// ─────────────────────────────────────────────────────────────────────────────

import { z } from "zod";

export const LANGUAGES = ["en", "fr", "it", "nl", "ar", "he"] as const;
export type Language = (typeof LANGUAGES)[number];

export const LanguageSchema = z.enum(LANGUAGES).default("en");

export interface LanguageMeta {
  code: Language;
  englishName: string;
  nativeName: string;
  rtl: boolean;
  charWidthRatio: number;
  // CSS font-family stack — first match wins. The render route loads the
  // primary fonts via Google Fonts; system / sans-serif close the stack.
  fontStack: string;
  arrow: { forward: string };
  // Default risk-warning string used as a fallback when the brand kit
  // doesn't ship a localized disclaimer. Operators can still override
  // via brief.notes.
  fallbackDisclaimer: string;
  // Common consultant-ese / cliché words to avoid in this language.
  // Used by the critique pass.
  bannedClichés: string[];
}

export const LANG_META: Record<Language, LanguageMeta> = {
  en: {
    code: "en",
    englishName: "English",
    nativeName: "English",
    rtl: false,
    charWidthRatio: 0.55,
    fontStack: '"Poppins", "Inter", system-ui, sans-serif',
    arrow: { forward: "→" },
    fallbackDisclaimer:
      "Caution. Investing involves risk of loss. Third party fees and Terms & conditions apply.",
    bannedClichés: ["smart", "smarter", "future", "potential", "unlock", "discover", "experience", "elevate", "transform", "empower", "reimagine"],
  },
  fr: {
    code: "fr",
    englishName: "French",
    nativeName: "Français",
    rtl: false,
    charWidthRatio: 0.56,
    fontStack: '"Poppins", "Inter", system-ui, sans-serif',
    arrow: { forward: "→" },
    fallbackDisclaimer:
      "Attention. Investir comporte un risque de perte. Des frais tiers et les Conditions générales s'appliquent.",
    bannedClichés: ["intelligent", "avenir", "potentiel", "révéler", "découvrez", "transformez", "réinventer", "libérez"],
  },
  it: {
    code: "it",
    englishName: "Italian",
    nativeName: "Italiano",
    rtl: false,
    charWidthRatio: 0.55,
    fontStack: '"Poppins", "Inter", system-ui, sans-serif',
    arrow: { forward: "→" },
    fallbackDisclaimer:
      "Attenzione. Investire comporta rischio di perdita. Si applicano commissioni di terzi e Termini e condizioni.",
    bannedClichés: ["intelligente", "futuro", "potenziale", "scopri", "rivela", "trasforma", "reinventa", "libera"],
  },
  nl: {
    code: "nl",
    englishName: "Dutch",
    nativeName: "Nederlands",
    rtl: false,
    charWidthRatio: 0.56,
    fontStack: '"Poppins", "Inter", system-ui, sans-serif',
    arrow: { forward: "→" },
    fallbackDisclaimer:
      "Let op. Beleggen brengt risico's met zich mee. Kosten van derden en Algemene voorwaarden zijn van toepassing.",
    bannedClichés: ["slim", "slimmer", "toekomst", "potentieel", "ontdek", "ervaar", "transformeer", "ontgrendel"],
  },
  ar: {
    code: "ar",
    englishName: "Arabic",
    nativeName: "العربية",
    rtl: true,
    // Arabic with ligatures averages slightly wider than Latin in
    // proportional sans-serif. 0.6 is empirically close for Cairo/Tajawal.
    charWidthRatio: 0.6,
    fontStack: '"Cairo", "Tajawal", "Noto Sans Arabic", system-ui, sans-serif',
    arrow: { forward: "←" },
    fallbackDisclaimer:
      "تنبيه: الاستثمار ينطوي على مخاطر الخسارة. تنطبق رسوم الأطراف الثالثة والشروط والأحكام.",
    bannedClichés: ["ذكي", "المستقبل", "اكتشف", "حرر", "حول"],
  },
  he: {
    code: "he",
    englishName: "Hebrew",
    nativeName: "עברית",
    rtl: true,
    // Hebrew letters are narrower than Latin sans-serif.
    charWidthRatio: 0.5,
    fontStack: '"Heebo", "Rubik", "Noto Sans Hebrew", system-ui, sans-serif',
    arrow: { forward: "←" },
    fallbackDisclaimer:
      "אזהרה. השקעה כרוכה בסיכון להפסד. עמלות צד שלישי ותנאי שימוש חלים.",
    bannedClichés: ["חכם", "עתיד", "פוטנציאל", "גלה", "לחוות", "לחוות", "לפרוץ"],
  },
};

// Convenience helpers
export function isRtl(lang: Language): boolean {
  return LANG_META[lang].rtl;
}

export function nativeName(lang: Language): string {
  return LANG_META[lang].nativeName;
}

// CSS-ready URL for loading every supported language's fonts in one request.
// Used by the /render/ad/[adId] page so headless Chromium has the right
// glyphs available no matter what language the manifest contains.
export const GOOGLE_FONTS_HREF =
  "https://fonts.googleapis.com/css2?" +
  [
    "family=Poppins:wght@400;600;700;800&display=swap",
    "family=Heebo:wght@400;600;700;800&display=swap",
    "family=Rubik:wght@400;600;700;800&display=swap",
    "family=Cairo:wght@400;600;700;800&display=swap",
    "family=Tajawal:wght@400;500;700;800&display=swap",
    "family=Noto+Sans+Hebrew:wght@400;600;700&display=swap",
    "family=Noto+Sans+Arabic:wght@400;600;700&display=swap",
  ].join("&");
