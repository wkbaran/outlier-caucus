import { test, expect, type Page } from "@playwright/test";
import { buildHtmlReport } from "../src/output/html.js";
import type { AnalysisReport } from "../src/services/analysis-service.js";

// A report built on Sep 24 knows only itself and older runs. The live manifest
// has a newer run, published after this page was written.
const report = {
  generatedAt: "2026-09-24T13:00:00Z",
  totalTradesAnalyzed: 0,
  scoredTrades: [],
  summary: { topByScore: [], byRarity: [], byCommitteeRelevance: [], symbolStats: { totalSymbols: 0, uniqueSymbols: 0, rareSymbols: 0 } },
} as unknown as AnalysisReport;

const HTML = buildHtmlReport({
  report,
  salesTrades: [],
  purchaseTrades: [],
  dateLabel: "September 24, 2026",
  dateStr: "2026-09-24",
  indexUrl: "../archive.html",
  runs: [
    { date: "2026-09-24", label: "September 24, 2026", href: "../2026-09-24/report.html", newTrades: 5 },
    { date: "2026-09-23", label: "September 23, 2026", href: "../2026-09-23/report.html", newTrades: 2 },
  ],
});

const MANIFEST = [
  { date: "2026-09-29", dateLabel: "September 29, 2026", file: "2026-09-29/report.html", totalTrades: 10, topSymbols: [], newTrades: 7 },
  { date: "2026-09-24", dateLabel: "September 24, 2026", file: "2026-09-24/report.html", totalTrades: 9, topSymbols: [], newTrades: 5 },
  { date: "2026-09-23", dateLabel: "September 23, 2026", file: "2026-09-23/report.html", totalTrades: 8, topSymbols: [], newTrades: 2 },
];

async function open(page: Page, manifest: { status: number; body: string }) {
  await page.route("http://site.test/2026-09-24/report.html", (r) => r.fulfill({ contentType: "text/html", body: HTML }));
  await page.route("http://site.test/manifest.json", (r) => r.fulfill({ contentType: "application/json", ...manifest }));
  await page.goto("http://site.test/2026-09-24/report.html");
}

test("picker picks up reports published after the page was built", async ({ page }) => {
  await open(page, { status: 200, body: JSON.stringify(MANIFEST) });
  const options = page.locator("#run option");
  await expect(options).toHaveCount(3);
  await expect(options.first()).toHaveText("September 29, 2026 (7 new)");
  await expect(page.locator("#run")).toHaveValue("../2026-09-24/report.html");
});

test("an older report links to the latest one", async ({ page }) => {
  await open(page, { status: 200, body: JSON.stringify(MANIFEST) });
  await expect(page.locator(".run-latest")).toHaveAttribute("href", "../2026-09-29/report.html");
});

test("the latest report shows no link to itself", async ({ page }) => {
  await open(page, { status: 200, body: JSON.stringify(MANIFEST.slice(1)) });
  await expect(page.locator("#run option")).toHaveCount(2);
  await expect(page.locator(".run-latest")).toHaveCount(0);
});

test("baked-in options stay when the manifest cannot be loaded", async ({ page }) => {
  await open(page, { status: 404, body: "" });
  await expect(page.locator("#run option")).toHaveCount(2);
  await expect(page.locator(".run-latest")).toHaveCount(0);
});
