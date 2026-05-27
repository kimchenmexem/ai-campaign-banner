import path from "node:path";
import { promises as fs } from "node:fs";
import Link from "next/link";
import { BrandKitLiteSchema } from "@/lib/schemas/brandKit.schema";
import { FigmaAdapterClient } from "./FigmaAdapterClient";

export const dynamic = "force-dynamic";

async function loadDisclaimersByLanguage() {
  try {
    const file = path.join(process.cwd(), "data", "brand-kit-lite.generated.json");
    const raw = await fs.readFile(file, "utf8");
    const kit = BrandKitLiteSchema.parse(JSON.parse(raw));
    return {
      defaultDisclaimer: kit.legal.default_disclaimer,
      disclaimersByLanguage: kit.legal.disclaimers_by_language ?? {},
    };
  } catch {
    return {
      defaultDisclaimer: "Caution. Investing involves risk of loss.",
      disclaimersByLanguage: {},
    };
  }
}

export default async function FigmaAdapterPage() {
  const disclaimers = await loadDisclaimersByLanguage();

  return (
    <section className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Figma Adapter</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Start from one approved English SVG exported from Figma, keep the design as
            editable vector layers, and generate size/language variants from the same source.
          </p>
        </div>
        <Link
          href="/campaigns"
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-900 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:hover:bg-zinc-900"
        >
          Campaign history
        </Link>
      </header>
      <FigmaAdapterClient {...disclaimers} />
    </section>
  );
}
