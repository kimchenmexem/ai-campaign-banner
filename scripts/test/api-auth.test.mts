/* eslint-disable no-console */
// Proves that anonymous mutation is rejected on each protected route.
//
// We don't run the Next.js server. We invoke the route handlers directly
// after un-setting AUTH_DISABLED so the guards engage. The expected behavior
// is 401 (no token) or 503 (no Supabase env configured to validate tokens).

import { test, runTests, assert } from "./harness";

function setEnv(key: string, value: string | undefined) {
  const env = process.env as unknown as Record<string, string | undefined>;
  if (value === undefined) delete env[key];
  else env[key] = value;
}

setEnv("AUTH_DISABLED", undefined);
setEnv("NODE_ENV", "development");

function jsonBody(obj: unknown) {
  return new Request("http://t/api/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(obj),
  });
}

async function expectUnauthorized(handler: (r: Request) => Promise<Response>, req: Request, label: string) {
  const res = await handler(req);
  assert(
    res.status === 401 || res.status === 503,
    `${label}: expected 401 (or 503 when Supabase env missing), got ${res.status}`,
  );
}

test("render-campaign POST rejects anonymous", async () => {
  const mod = await import("@/app/api/render-campaign/route");
  await expectUnauthorized(mod.POST, jsonBody({ campaign_id: "x" }), "render-campaign");
});

test("generate-campaign POST rejects anonymous", async () => {
  const mod = await import("@/app/api/generate-campaign/route");
  await expectUnauthorized(mod.POST, jsonBody({ brief: {} }), "generate-campaign");
});

test("midjourney/uploads POST rejects anonymous (multipart)", async () => {
  const mod = await import("@/app/api/midjourney/uploads/route");
  const fd = new FormData();
  fd.append("prompt_id", "p");
  const req = new Request("http://t/api/midjourney/uploads", { method: "POST", body: fd });
  await expectUnauthorized(mod.POST, req, "midjourney/uploads");
});

test("midjourney/uploads DELETE rejects anonymous", async () => {
  const mod = await import("@/app/api/midjourney/uploads/route");
  const req = new Request("http://t/api/midjourney/uploads?upload_id=mj_x", { method: "DELETE" });
  await expectUnauthorized(mod.DELETE, req, "midjourney/uploads DELETE");
});

test("brand-kit PATCH rejects anonymous", async () => {
  const mod = await import("@/app/api/brand-kit/route");
  await expectUnauthorized(mod.PATCH, jsonBody({}), "brand-kit");
});

test("screenshot-tags POST rejects anonymous", async () => {
  const mod = await import("@/app/api/screenshot-tags/route");
  await expectUnauthorized(mod.POST, jsonBody({ tags: [] }), "screenshot-tags");
});

test("mockup-manifest POST rejects anonymous", async () => {
  const mod = await import("@/app/api/mockup-manifest/route");
  await expectUnauthorized(mod.POST, jsonBody({ entries: [] }), "mockup-manifest");
});

test("upload-asset POST rejects anonymous", async () => {
  const mod = await import("@/app/api/upload-asset/route");
  const fd = new FormData();
  const req = new Request("http://t/api/upload-asset", { method: "POST", body: fd });
  await expectUnauthorized(mod.POST, req, "upload-asset");
});

test("asset DELETE rejects anonymous", async () => {
  const mod = await import("@/app/api/asset/route");
  const req = new Request("http://t/api/asset", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ public_path: "/brand-input-preview/x/y.png" }),
  });
  await expectUnauthorized(mod.DELETE, req, "asset DELETE");
});

test("generators/asset[id] DELETE rejects anonymous", async () => {
  const mod = await import("@/app/api/generators/asset/[id]/route");
  const req = new Request("http://t/api/generators/asset/x", { method: "DELETE" });
  await expectUnauthorized(
    (r) => mod.DELETE(r, { params: Promise.resolve({ id: "x" }) }),
    req,
    "generators/asset DELETE",
  );
});

test("dev-only routes refuse in production with 404 (no flag)", async () => {
  const prev = process.env.NODE_ENV;
  setEnv("NODE_ENV", "production");
  try {
    const mod = await import("@/app/api/screenshot-tags/route");
    // Even with a (fake) session, refuseInProduction blocks first.
    setEnv("AUTH_DISABLED", "true");
    const res = await mod.POST(jsonBody({ tags: [] }));
    assert(res.status === 404, `expected 404 in prod, got ${res.status}`);
  } finally {
    setEnv("NODE_ENV", prev);
    setEnv("AUTH_DISABLED", undefined);
  }
});

runTests();
