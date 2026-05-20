import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Desktop is iCloud-synced. iCloud's fileproviderd holds .next/ files open
  // while syncing, which collides with Turbopack's high-frequency cache
  // writes ("Persisting failed: No such file or directory", missing CSS
  // chunks, "Cannot find module .../[turbopack]_runtime.js"). Names ending
  // in ".nosync" are excluded from iCloud Drive sync. Keep distDir INSIDE
  // the project so PostCSS / Tailwind module resolution still works.
  distDir: ".next.nosync",
};

export default nextConfig;
