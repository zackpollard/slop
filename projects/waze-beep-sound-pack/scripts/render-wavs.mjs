// Render every beep in index.html to a WAV file, headlessly.
//
// The browser is the single source of truth for the sound design, so instead of
// reimplementing the synthesis we just load the page in headless Chromium and
// click each "WAV" download button — the downloaded bytes are identical to what
// a user previews and downloads.
//
// Usage: node render-wavs.mjs <output-dir>

import { chromium } from "playwright";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve, join } from "node:path";
import { mkdirSync } from "node:fs";

const outDir = resolve(process.argv[2] || "./_wavs");
mkdirSync(outDir, { recursive: true });

const here = dirname(fileURLToPath(import.meta.url));
const indexHtml = resolve(here, "..", "index.html");

const browser = await chromium.launch();
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage();

const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await page.goto(pathToFileURL(indexHtml).href, { waitUntil: "load" });
await page.waitForSelector(".btn-dl");

const count = await page.$$eval(".btn-dl", (els) => els.length);
for (let i = 0; i < count; i++) {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.locator(".btn-dl").nth(i).click(),
  ]);
  const name = download.suggestedFilename();
  await download.saveAs(join(outDir, name));
  console.log("rendered", name);
}

await browser.close();

if (errors.length) {
  console.error("page errors:", errors);
  process.exit(1);
}
console.log(`rendered ${count} WAV file(s) to ${outDir}`);
