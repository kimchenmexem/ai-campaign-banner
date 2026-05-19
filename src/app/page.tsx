import Link from "next/link";

const SECTIONS = [
  {
    href: "/campaign-planner",
    title: "Campaign Planner",
    blurb: "Brief the AI, get concepts + ad specs back as a saved CampaignPlan.",
  },
  {
    href: "/campaigns",
    title: "Campaigns",
    blurb: "Saved AI campaigns: concepts, ad specs, manifests, rendered banners.",
  },
  {
    href: "/assets",
    title: "Assets",
    blurb: "All elements in use across the brand kit. View, browse by type, add new uploads.",
  },
  {
    href: "/settings",
    title: "Settings",
    blurb: "Brand kit, AI provider, Bannerbear template map.",
  },
];

export default function Home() {
  return (
    <section className="space-y-8">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">AI Campaign Banner Generator</h1>
        <p className="text-zinc-600 dark:text-zinc-400">
          MVP — campaign planning, banner rendering via Bannerbear, asset storage on
          Cloudinary, manifests + QA on Supabase, ZIP export.
        </p>
      </header>
      <ul className="grid gap-4 sm:grid-cols-3">
        {SECTIONS.map((s) => (
          <li
            key={s.href}
            className="rounded-lg border border-zinc-200 p-4 hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600"
          >
            <Link href={s.href} className="block space-y-2">
              <h2 className="font-medium">{s.title}</h2>
              <p className="text-sm text-zinc-600 dark:text-zinc-400">{s.blurb}</p>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
