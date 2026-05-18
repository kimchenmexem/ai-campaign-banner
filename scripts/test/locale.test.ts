/* eslint-disable no-console */
import { test, runTests, assertEqual } from "./harness";
import { mapLanguageToLocale } from "@/lib/ai/campaignPlanner";

test("mapLanguageToLocale supports LTR languages", () => {
  assertEqual(mapLanguageToLocale("en"), "en-GB");
  assertEqual(mapLanguageToLocale("fr"), "fr-FR");
  assertEqual(mapLanguageToLocale("it"), "it-IT");
  assertEqual(mapLanguageToLocale("nl"), "nl-NL");
});

test("mapLanguageToLocale supports Hebrew (he → he-IL)", () => {
  assertEqual(mapLanguageToLocale("he"), "he-IL");
});

test("mapLanguageToLocale supports Arabic (ar → ar-AE)", () => {
  assertEqual(mapLanguageToLocale("ar"), "ar-AE");
});

test("mapLanguageToLocale throws on unknown language", () => {
  let threw = false;
  try {
    mapLanguageToLocale("xx");
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("expected throw for unsupported language");
});

runTests();
