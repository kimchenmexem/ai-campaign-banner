export default function AssetsPage() {
  return (
    <section className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Assets</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Manually uploaded Midjourney outputs, logos, and product photos. Stored on
          Cloudinary, indexed in Supabase.
        </p>
      </header>
      <p className="text-sm text-zinc-500">Asset list and uploader coming next.</p>
    </section>
  );
}
