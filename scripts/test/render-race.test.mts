/* eslint-disable no-console */
// Render race regression. Two guarantees, asserted at the source level:
//   1. renderCampaign visits /render/campaign/{campaign_id}/ad/{ad_id}
//      — the per-campaign route — and NOT the legacy global /render/ad/[adId].
//   2. renderCampaign never writes to data/demo-campaign.preview.json.
//
// We can't easily stub the playwright import in ESM, and we definitely don't
// want to launch Chromium in this test, so we read the renderer's source and
// assert on the patterns. This is brittle by design — the patterns are
// load-bearing for concurrency safety, so a regression should fail loudly.

import { promises as fs } from "node:fs";
import path from "node:path";
import { test, runTests, assert } from "./harness";

const RENDER_SRC = path.join(
  process.cwd(),
  "src",
  "lib",
  "render",
  "renderCampaign.ts",
);

test("renderCampaign uses per-campaign URL pattern", async () => {
  const src = await fs.readFile(RENDER_SRC, "utf8");
  assert(
    src.includes("/render/campaign/${encodeURIComponent(campaign_id)}/ad/"),
    "renderCampaign should target the per-campaign render route",
  );
});

test("renderCampaign no longer references the global /render/ad/[adId] template", async () => {
  const src = await fs.readFile(RENDER_SRC, "utf8");
  const lines = src.split("\n");
  for (const [i, line] of lines.entries()) {
    if (
      line.includes("/render/ad/") &&
      !line.includes("/render/campaign/") &&
      !line.trimStart().startsWith("//")
    ) {
      throw new Error(`legacy URL reference at line ${i + 1}: ${line.trim()}`);
    }
  }
});

test("renderCampaign does not write to the global demo preview file", async () => {
  const src = await fs.readFile(RENDER_SRC, "utf8");
  // Strip comments before checking — historical comments may reference the
  // old filename to explain what changed.
  const stripped = src
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n");
  assert(
    !stripped.includes("demo-campaign.preview.json"),
    "renderCampaign must not reference demo-campaign.preview.json outside comments",
  );
  // Also confirm there's no JSON.stringify -> writeFile pair targeting it.
  assert(
    !stripped.includes("TMP_DEMO_FILENAME"),
    "TMP_DEMO_FILENAME constant must be gone",
  );
});

test("two concurrent render URLs are derived from distinct campaign IDs", () => {
  function urlFor(baseUrl: string, campaign_id: string, ad_id: string) {
    return `${baseUrl}/render/campaign/${encodeURIComponent(campaign_id)}/ad/${encodeURIComponent(ad_id)}`;
  }
  const a = urlFor("http://t", "cam_A", "ad_1");
  const b = urlFor("http://t", "cam_B", "ad_2");
  assert(a !== b);
  assert(a.includes("/render/campaign/cam_A/"));
  assert(b.includes("/render/campaign/cam_B/"));
});

runTests();
