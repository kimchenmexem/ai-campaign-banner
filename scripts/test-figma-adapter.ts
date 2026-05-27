#!/usr/bin/env tsx
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import { chromium, type Page } from "playwright";

const SAMPLE_FIGMA_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="628" viewBox="0 0 1200 628"><rect width="1200" height="628" fill="#00122C"/><circle cx="980" cy="160" r="120" fill="#006A97" opacity="0.55"/><text x="70" y="92" fill="#FFFFFF" font-family="Poppins" font-size="42" font-weight="800">MEXEM</text><text x="70" y="235" fill="#F5C518" font-family="Poppins" font-size="74" font-weight="800">Compare markets</text><text x="70" y="320" fill="#FFFFFF" font-family="Poppins" font-size="44" font-weight="600">Follow data and act with control</text><text x="70" y="515" fill="#FFFFFF" font-family="Poppins" font-size="22">Caution. Investing involves risk of loss.</text><rect x="760" y="480" width="300" height="76" rx="38" fill="#FFFFFF"/><text x="800" y="528" fill="#0A0F1F" font-family="Poppins" font-size="30" font-weight="800">Explore platform</text></svg>`;
const SOURCE_SVG_PATH = process.env.FIGMA_ADAPTER_TEST_SVG_PATH
  ? path.resolve(process.env.FIGMA_ADAPTER_TEST_SVG_PATH)
  : null;
const OUTLINED_TEST_DISABLED_LANGUAGES = ["Français", "Italiano", "Nederlands", "العربية", "עברית"];

const MOCK_TRANSLATIONS = {
  "1": {
    en: "Compare markets",
    fr: "Comparer les marches",
    it: "Confronta i mercati",
    nl: "Vergelijk markten",
    ar: "قارن الأسواق",
    he: "השווה שווקים",
  },
  "2": {
    en: "Follow data and act with control",
    fr: "Suivez les donnees et agissez avec controle",
    it: "Segui i dati e agisci con controllo",
    nl: "Volg gegevens en handel met controle",
    ar: "تابع البيانات وتصرف بتحكم",
    he: "עקוב אחר הנתונים ופעל בשליטה",
  },
  "4": {
    en: "Explore platform",
    fr: "Explorer la plateforme",
    it: "Esplora la piattaforma",
    nl: "Verken het platform",
    ar: "استكشف المنصة",
    he: "חקור את הפלטפורמה",
  },
};

const EXPECTED_TEXT_ROLES = ["logo", "headline", "subheadline", "disclaimer", "cta"];

interface TranslationRequestLayer {
  index: number;
  text: string;
  role: string;
}

interface TranslationRequest {
  layers: TranslationRequestLayer[];
  languages: string[];
}

interface CampaignIndexFile {
  generated_at: string;
  active_campaign_id: string | null;
  campaigns: Array<{ campaign_id: string } & Record<string, unknown>>;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  const externalBaseUrl = process.env.FIGMA_ADAPTER_TEST_BASE_URL;
  const runningBaseUrl = externalBaseUrl ? null : await findRunningNextDevServer();
  const server = externalBaseUrl || runningBaseUrl ? null : await startNextDevServer();
  const baseUrl = externalBaseUrl ?? runningBaseUrl ?? server?.baseUrl;
  assert(baseUrl, "Expected a base URL for the Figma adapter test.");

  try {
    await waitForServer(baseUrl, server?.getLogs);
    await runBrowserChecks(baseUrl);
    console.log("✓ Figma adapter smoke test passed");
  } finally {
    await server?.stop();
  }
}

async function runBrowserChecks(baseUrl: string) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
  const consoleErrors: string[] = [];
  let translationRequest: TranslationRequest | null = null;
  let savedCampaignId: string | null = null;

  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(err.message));

  await page.route("**/api/figma-adapter/translate", async (route) => {
    translationRequest = route.request().postDataJSON() as TranslationRequest;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        source: "test",
        translations: MOCK_TRANSLATIONS,
      }),
    });
  });

  try {
    await page.goto(`${baseUrl}/figma-adapter`, { waitUntil: "networkidle" });
    await pasteSourceSvg(page);
    const layoutMode = await assertExtractedLayout(page);
    if (layoutMode === "editable-text") {
      await assertMockTranslation(page, () => translationRequest);
      savedCampaignId = await assertSaveToCampaignHistory(page, baseUrl);
    } else {
      await assertOutlinedTranslationIsSkipped(page, () => translationRequest);
    }

    assert(
      consoleErrors.length === 0,
      `Unexpected browser console errors:\n${consoleErrors.join("\n")}`,
    );
  } finally {
    await browser.close();
    if (savedCampaignId && process.env.FIGMA_ADAPTER_TEST_KEEP_CAMPAIGN !== "1") {
      await cleanupSavedCampaign(savedCampaignId);
    }
  }
}

async function pasteSourceSvg(page: Page) {
  if (SOURCE_SVG_PATH) {
    await fs.access(SOURCE_SVG_PATH);
    await page.locator('input[type="file"]').setInputFiles(SOURCE_SVG_PATH);
    await page.waitForFunction(
      () => (document.body.textContent ?? "").includes("outlined fallback"),
      { timeout: 60_000 },
    );
    for (const languageName of OUTLINED_TEST_DISABLED_LANGUAGES) {
      await page.getByText(languageName, { exact: true }).click();
    }
    await page.waitForFunction(
      () => (document.body.textContent ?? "").includes("15 editable SVG variants"),
      { timeout: 60_000 },
    );
  } else {
    const input = page.locator('textarea[placeholder^="<svg"]');
    await input.waitFor({ state: "visible", timeout: 20_000 });
    await input.click();
    await page.keyboard.insertText(SAMPLE_FIGMA_SVG);
    await page.waitForFunction(
      () => (document.body.textContent ?? "").includes("Source: 1200 x 628 · 5 text layers"),
      { timeout: 20_000 },
    );
  }
  await page.waitForFunction(
    () => document.querySelectorAll('svg[data-source="figma-adapter"]').length === 12,
    { timeout: 60_000 },
  );
}

async function assertExtractedLayout(page: Page): Promise<"editable-text" | "outlined-vector"> {
  const result = await page.evaluate(() => {
    const previews = Array.from(document.querySelectorAll('svg[data-source="figma-adapter"]'));
    const firstSvg = previews[0] ?? null;
    const firstOuter = firstSvg?.outerHTML ?? "";
    const roleValues = Array.from(document.querySelectorAll("select"))
      .slice(1)
      .map((select) => select.value);
    const firstTexts = Array.from(
      firstSvg?.querySelectorAll('g[data-layer-role="adaptive-layout"] text') ?? [],
    ).map((el) => ({
      role: el.getAttribute("data-text-role"),
      text: el.textContent?.trim() ?? "",
    }));
    const sourceArtworkTextCount =
      firstSvg?.querySelector('g[data-layer-role="source-artwork"]')?.querySelectorAll("text")
        .length ?? -1;
    const outlinedSliceRoles = Array.from(
      firstSvg?.querySelectorAll('[data-layer-role="outlined-slice"]') ?? [],
    ).map((el) => el.getAttribute("data-slice-role"));

    return {
      bodyText: document.body.textContent ?? "",
      previewCount: previews.length,
      hasSourceArtwork: firstOuter.includes('data-layer-role="source-artwork"'),
      hasAdaptiveLayout: firstOuter.includes('data-layer-role="adaptive-layout"'),
      hasOutlinedLayout: firstOuter.includes('data-layer-role="outlined-layout"'),
      hasEditableTextNodes: firstOuter.includes("<text"),
      sourceArtworkTextCount,
      roleValues,
      firstTexts,
      outlinedSliceRoles,
    };
  });

  const outlinedMode = result.bodyText.includes("outlined fallback");
  const expectedVariantCount = outlinedMode ? "15 editable SVG variants" : "90 editable SVG variants";
  assert(result.bodyText.includes(expectedVariantCount), `Expected ${expectedVariantCount} to be generated.`);
  assert(result.previewCount === 12, `Expected 12 visible previews, got ${result.previewCount}.`);
  if (outlinedMode) {
    assert(result.hasOutlinedLayout, "Expected outlined layout layer in generated SVG.");
    for (const role of ["brand", "headline", "cta"]) {
      assert(result.outlinedSliceRoles.includes(role), `Expected outlined fallback to include ${role} slice.`);
    }
    await assertOutlinedSlicesStayInsideCanvas(page);
    return "outlined-vector";
  }

  assert(result.hasSourceArtwork, "Expected source artwork layer in generated SVG.");
  assert(result.hasAdaptiveLayout, "Expected adaptive layout layer in generated SVG.");
  assert(result.hasEditableTextNodes, "Expected generated SVG to keep editable <text> nodes.");
  assert(result.sourceArtworkTextCount === 0, "Expected source artwork to have text stripped out.");
  assert(
    JSON.stringify(result.roleValues) === JSON.stringify(EXPECTED_TEXT_ROLES),
    `Unexpected extracted roles: ${JSON.stringify(result.roleValues)}`,
  );

  const firstRoles = result.firstTexts.map((item) => item.role);
  for (const role of ["logo", "headline", "subheadline", "cta", "disclaimer"]) {
    assert(firstRoles.includes(role), `Expected first preview to include ${role} text.`);
  }

  const layoutIssues = await page.evaluate<string[]>(`(() => {
    const outOfBoundsTolerance = 8;
    const overlapAreaTolerance = 12;
    const issues = [];
    const boxOf = (el) => {
      const box = el.getBBox();
      return {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        role: el.getAttribute("data-text-role") || "unknown",
        text: (el.textContent || "").trim(),
      };
    };
    const overlapArea = (a, b) => {
      const x = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
      const y = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
      return x * y;
    };
    for (const svg of Array.from(document.querySelectorAll('svg[data-source="figma-adapter"]'))) {
      const viewBox = svg.viewBox.baseVal;
      const format = svg.getAttribute("data-format") || "unknown";
      const texts = Array.from(
        svg.querySelectorAll('g[data-layer-role="adaptive-layout"] text'),
      ).map(boxOf);
      for (const text of texts) {
        const outside =
          text.x < -outOfBoundsTolerance ||
          text.y < -outOfBoundsTolerance ||
          text.x + text.width > viewBox.width + outOfBoundsTolerance ||
          text.y + text.height > viewBox.height + outOfBoundsTolerance;
        if (outside) {
          issues.push(format + ": " + text.role + " text is outside the canvas (" + text.text + ")");
        }
      }
      for (let i = 0; i < texts.length; i += 1) {
        for (let j = i + 1; j < texts.length; j += 1) {
          const area = overlapArea(texts[i], texts[j]);
          if (area > overlapAreaTolerance) {
            issues.push(
              format + ": " + texts[i].role + " overlaps " + texts[j].role + " by " + area.toFixed(1) + "px",
            );
          }
        }
      }
    }
    return issues;
  })()`);

  assert(layoutIssues.length === 0, `Layout issues found:\n${layoutIssues.join("\n")}`);
  return "editable-text";
}

async function assertOutlinedSlicesStayInsideCanvas(page: Page) {
  const layoutIssues = await page.evaluate<string[]>(`(() => {
    const issues = [];
    for (const svg of Array.from(document.querySelectorAll('svg[data-source="figma-adapter"]'))) {
      const viewBox = svg.viewBox.baseVal;
      const format = svg.getAttribute("data-format") || "unknown";
      for (const slice of Array.from(svg.querySelectorAll('[data-layer-role="outlined-slice"]'))) {
        const x = Number(slice.getAttribute("data-slice-x") || 0);
        const y = Number(slice.getAttribute("data-slice-y") || 0);
        const width = Number(slice.getAttribute("data-slice-width") || 0);
        const height = Number(slice.getAttribute("data-slice-height") || 0);
        const role = slice.getAttribute("data-slice-role") || "unknown";
        if (x < -1 || y < -1 || x + width > viewBox.width + 1 || y + height > viewBox.height + 1) {
          issues.push(format + ": " + role + " slice is outside the canvas");
        }
      }
    }
    return issues;
  })()`);

  assert(layoutIssues.length === 0, `Outlined layout issues found:\n${layoutIssues.join("\n")}`);
}

async function assertOutlinedTranslationIsSkipped(
  page: Page,
  getTranslationRequest: () => TranslationRequest | null,
) {
  await page.getByRole("button", { name: "Auto-translate layers" }).click();
  await page.waitForFunction(
    () => (document.body.textContent ?? "").includes("No translatable text layers were found."),
    { timeout: 20_000 },
  );
  assert(getTranslationRequest() === null, "Outlined source should not call the translation endpoint.");
}

async function assertMockTranslation(
  page: Page,
  getTranslationRequest: () => TranslationRequest | null,
) {
  await page.getByRole("button", { name: "Auto-translate layers" }).click();
  await page.waitForFunction(
    () => (document.body.textContent ?? "").includes("Translated 3 extracted text layers."),
    { timeout: 20_000 },
  );

  const request = getTranslationRequest();
  assert(request !== null, "Expected auto-translate to call the translation endpoint.");
  assert(
    JSON.stringify(request.layers.map((layer) => layer.index)) === JSON.stringify([1, 2, 4]),
    `Translation request included wrong layers: ${JSON.stringify(request.layers)}`,
  );
  assert(
    request.layers.every((layer) => !["logo", "disclaimer", "locked"].includes(layer.role)),
    `Translation request should exclude logo/disclaimer/locked layers: ${JSON.stringify(request.layers)}`,
  );
  assert(
    JSON.stringify(request.languages) === JSON.stringify(["en", "fr", "it", "nl", "ar", "he"]),
    `Translation request included wrong languages: ${JSON.stringify(request.languages)}`,
  );

  const result = await page.evaluate(() => ({
    bodyText: document.body.textContent ?? "",
    textareaValues: Array.from(document.querySelectorAll("textarea")).map((textarea) => textarea.value),
  }));
  assert(
    !result.bodyText.includes("still uses English"),
    "Expected non-English warnings to clear after translation.",
  );
  for (const expected of [
    "Suivez les donnees et agissez avec controle",
    "Confronta i mercati",
    "Volg gegevens en handel met controle",
    "تابع البيانات وتصرف بتحكم",
    "עקוב אחר הנתונים ופעל בשליטה",
  ]) {
    assert(
      result.textareaValues.includes(expected),
      `Expected translated textarea value: ${expected}`,
    );
  }
}

async function assertSaveToCampaignHistory(page: Page, baseUrl: string): Promise<string> {
  await page.getByRole("button", { name: "Save to campaign history" }).click();
  await page.waitForFunction(
    () => (document.body.textContent ?? "").includes("Saved to campaign history as"),
    { timeout: 20_000 },
  );

  const href = await page.getByRole("link", { name: "Open campaign" }).getAttribute("href");
  assert(href, "Expected saved campaign link to be visible.");
  const parsedCampaignId = href.split("/").filter(Boolean).at(-1);
  assert(
    typeof parsedCampaignId === "string" && parsedCampaignId.startsWith("cam_figma_"),
    `Unexpected saved campaign href: ${href}`,
  );
  const campaignId = parsedCampaignId;

  await page.goto(`${baseUrl}/campaigns`, { waitUntil: "networkidle" });
  const historyText = await page.locator("body").innerText({ timeout: 10_000 });
  assert(historyText.includes("Figma Adapter"), "Expected history list to label the saved item as Figma Adapter.");
  assert(historyText.includes("editable SVG"), "Expected history list to describe Figma output as editable SVGs.");
  const historyLink = page.locator(`a[href="/campaigns/${campaignId}"]`);
  assert(
    (await historyLink.count()) === 1,
    `Expected saved campaign ${campaignId} to appear exactly once in history.`,
  );
  await historyLink.click();
  await page.waitForFunction(
    (expectedPath) => window.location.pathname === expectedPath,
    `/campaigns/${campaignId}`,
    { timeout: 20_000 },
  );

  const detail = await page.evaluate(() => ({
    bodyText: document.body.textContent ?? "",
    previewCount: document.querySelectorAll('svg[data-source="figma-adapter"]').length,
    combinedDownload: document.querySelector('a[href*="/api/figma-adapter/export"][href*="type=combined"]') !== null,
    zipDownload: document.querySelector('a[href*="/api/figma-adapter/export"][href*="type=zip"]') !== null,
  }));

  assert(detail.bodyText.includes("Figma Adapter"), "Expected campaign detail to show Figma Adapter source.");
  assert(detail.bodyText.includes(campaignId), "Expected campaign detail to show the saved campaign id.");
  assert(detail.previewCount >= 12, `Expected SVG previews on saved campaign detail, got ${detail.previewCount}.`);
  assert(detail.combinedDownload, "Expected saved campaign to expose combined SVG download.");
  assert(detail.zipDownload, "Expected saved campaign to expose ZIP download.");

  return campaignId;
}

async function cleanupSavedCampaign(campaignId: string) {
  const cwd = process.cwd();
  await fs.rm(path.join(cwd, "data", "campaigns", campaignId), {
    recursive: true,
    force: true,
  });
  const indexPath = path.join(cwd, "data", "campaigns", "index.generated.json");
  try {
    const index = JSON.parse(await fs.readFile(indexPath, "utf8")) as CampaignIndexFile;
    const next: CampaignIndexFile = {
      ...index,
      generated_at: new Date().toISOString(),
      active_campaign_id:
        index.active_campaign_id === campaignId ? null : index.active_campaign_id,
      campaigns: index.campaigns.filter((campaign) => campaign.campaign_id !== campaignId),
    };
    await fs.writeFile(indexPath, JSON.stringify(next, null, 2) + "\n", "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

async function startNextDevServer(): Promise<{
  baseUrl: string;
  getLogs: () => string;
  stop: () => Promise<void>;
}> {
  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn("npm", ["run", "dev", "--", "--port", String(port), "--hostname", "127.0.0.1"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port) },
    stdio: "pipe",
  });
  const logs: string[] = [];
  collectServerLogs(child, logs);

  child.once("exit", (code, signal) => {
    if (code !== null && code !== 0) {
      logs.push(`next dev exited with code ${code}`);
    }
    if (signal) logs.push(`next dev exited via signal ${signal}`);
  });

  return {
    baseUrl,
    getLogs: () => logs.join(""),
    stop: async () => {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 1500);
        child.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    },
  };
}

function collectServerLogs(child: ChildProcessWithoutNullStreams, logs: string[]) {
  child.stdout.on("data", (chunk: Buffer) => logs.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => logs.push(chunk.toString("utf8")));
}

async function findRunningNextDevServer(): Promise<string | null> {
  for (const baseUrl of ["http://localhost:3000", "http://127.0.0.1:3000"]) {
    if (await isFigmaAdapterReady(baseUrl)) return baseUrl;
  }
  return null;
}

async function isFigmaAdapterReady(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/figma-adapter`, { cache: "no-store" });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForServer(baseUrl: string, getLogs?: () => string) {
  const started = Date.now();
  let lastError = "";
  while (Date.now() - started < 60_000) {
    try {
      const res = await fetch(`${baseUrl}/figma-adapter`, { cache: "no-store" });
      if (res.ok) return;
      lastError = `${res.status} ${res.statusText}`;
    } catch (err) {
      lastError = (err as Error).message;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const logs = getLogs?.().trim();
  throw new Error(
    [
      `Timed out waiting for ${baseUrl}/figma-adapter. Last error: ${lastError}`,
      logs ? `Next dev output:\n${logs}` : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
  );
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert(typeof address === "object" && address !== null, "Expected a TCP server address.");
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
