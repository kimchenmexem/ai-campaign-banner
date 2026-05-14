import path from "node:path";
import { promises as fs } from "node:fs";
import { BrandKitLiteSchema } from "@/lib/schemas/brandKit.schema";
import { BrandKitForm } from "./BrandKitForm";

export const dynamic = "force-dynamic";

async function loadKit() {
  const file = path.join(process.cwd(), "data", "brand-kit-lite.generated.json");
  const raw = await fs.readFile(file, "utf8");
  return BrandKitLiteSchema.parse(JSON.parse(raw));
}

export default async function SettingsPage() {
  const kit = await loadKit();
  return (
    <section className="space-y-6 max-w-4xl">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Settings — Brand kit editor</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Edits write to <code className="text-xs">data/brand-kit-lite.generated.json</code>.
          The dev server reads the kit fresh on every campaign request, so changes apply
          to the next generated campaign without a restart. Per-format MEXEM rules (logo
          sizes, section gaps, element boxes) are intentionally not surfaced here — they
          live on the same JSON file and can be edited directly until a dedicated editor
          ships.
        </p>
      </header>
      <BrandKitForm initialKit={kit} />
    </section>
  );
}
