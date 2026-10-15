import { test, expect } from "@playwright/test";
import { buildHtmlReport } from "../src/output/html.js";
import type { AnalysisReport } from "../src/services/analysis-service.js";

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

const report = { generatedAt: new Date().toISOString(), totalTradesAnalyzed: 0, scoredTrades: [] } as unknown as AnalysisReport;

// A report page whose chart lists this many runs, one per day
const pageWithRuns = (count: number) => buildHtmlReport({
  report, purchaseTrades: [], salesTrades: [], dateLabel: "Today", dateStr: daysAgo(0), indexUrl: "../archive.html",
  runs: Array.from({ length: count }, (_, i) => ({
    date: daysAgo(i), label: `Day ${i}`, href: `../${daysAgo(i)}/report.html`, newTrades: 3 + (i % 7),
  })),
});

test("a phone shows the report without sideways scrolling, however many runs the chart lists", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const count of [2, 14]) {
    await page.setContent(pageWithRuns(count));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${count} runs`).toBe(true);
  }
});

test("the chart keeps a date under its newest bar on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setContent(pageWithRuns(14));
  const labels = page.locator(".runs a:last-child .d");
  await expect(labels).toBeVisible();
});
