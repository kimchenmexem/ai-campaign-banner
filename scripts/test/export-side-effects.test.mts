/* eslint-disable no-console */
// Source-level regression: GET /api/export-campaign-zip must not call
// renderCampaign and must return 409 when render artifacts are missing.

import { test, runTests, assert, assertEqual } from "./harness";
import { promises as fs } from "node:fs";
import path from "node:path";
void fs; // kept for symmetric tests if added later

const ROUTE_SRC = path.join(
  process.cwd(),
  "src",
  "app",
  "api",
  "export-campaign-zip",
  "route.ts",
);

test("source: GET export route does NOT import or call renderCampaign", async () => {
  const src = await fs.readFile(ROUTE_SRC, "utf8");
  assert(
    !src.includes("renderCampaign"),
    "export-campaign-zip GET route must not reference renderCampaign",
  );
});

test("source: GET export route returns 409 'not_ready' for missing artifact", async () => {
  const src = await fs.readFile(ROUTE_SRC, "utf8");
  assert(src.includes('"not_ready"') || src.includes("'not_ready'"));
  assert(src.includes("409"));
});

test("integration: GET export returns 404 when campaign does not exist", async () => {
  // The integration check uses a campaign-id that is guaranteed not to be
  // on disk. We rely on loadCampaignPlanIfExists returning null → 404. The
  // 409 'not_ready' branch is exercised by the source-level test above and
  // by manual QA — synthesising a schema-perfect plan here would be brittle
  // because CampaignPlanSchema is deep.
  process.env.AUTH_DISABLED = "true";
  (process.env as unknown as Record<string, string | undefined>).CAMPAIGN_REPO_DRIVER = "local";

  const { GET } = await import("@/app/api/export-campaign-zip/route");
  const campaignId = `cam_missing_${Date.now().toString(36)}`;
  const req = new Request(`http://t/api/export-campaign-zip?campaign_id=${campaignId}`);
  const res = await GET(req);
  // 404 not_found is the correct response when the plan doesn't exist.
  assertEqual(res.status, 404);
  const body = (await res.json()) as { error: string };
  assertEqual(body.error, "not_found");
});

test("integration: GET export returns 400 when campaign_id missing", async () => {
  process.env.AUTH_DISABLED = "true";
  const { GET } = await import("@/app/api/export-campaign-zip/route");
  const res = await GET(new Request("http://t/api/export-campaign-zip"));
  assertEqual(res.status, 400);
});

runTests();
