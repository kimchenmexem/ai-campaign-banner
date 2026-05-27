import path from "node:path";
import { promises as fs } from "node:fs";
import { BrandKitLiteSchema } from "@/lib/schemas/brandKit.schema";
import { BrandKitForm } from "./BrandKitForm";
import { CampaignDefaultsForm } from "./CampaignDefaultsForm";
import { loadCampaignDefaults } from "@/lib/settings/campaignDefaultsStore";

export const dynamic = "force-dynamic";

async function loadKit() {
  const file = path.join(process.cwd(), "data", "brand-kit-lite.generated.json");
  const raw = await fs.readFile(file, "utf8");
  return BrandKitLiteSchema.parse(JSON.parse(raw));
}

export default async function SettingsPage() {
  const kit = await loadKit();
  const campaignDefaults = await loadCampaignDefaults();
  return (
    <section className="space-y-6 max-w-4xl">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Campaign defaults write to{" "}
          <code className="text-xs">data/campaign-defaults.generated.json</code>.
          Brand-kit edits write to{" "}
          <code className="text-xs">data/brand-kit-lite.generated.json</code>.
        </p>
      </header>
      <section className="space-y-3">
        <header>
          <h2 className="text-lg font-semibold tracking-tight">Future campaign defaults</h2>
        </header>
        <CampaignDefaultsForm initialSettings={campaignDefaults} />
      </section>
      <section className="space-y-3">
        <header>
          <h2 className="text-lg font-semibold tracking-tight">Brand kit</h2>
        </header>
        <BrandKitForm initialKit={kit} />
      </section>
    </section>
  );
}
