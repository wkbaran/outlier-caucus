import { test, expect } from "@playwright/test";
import { buildHtmlReport } from "../src/output/html.js";
import type { AnalysisReport, AnalyzedTrade } from "../src/services/analysis-service.js";
import type { FMPTrade } from "../src/types/index.js";

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

const NO_FLAGS = { isSmallCap: false, isHighConviction: false, isRareStock: false, hasCommitteeRelevance: false, isDerivative: false, isIndirectOwnership: false };

let n = 0;
const trade = (o: Partial<FMPTrade>): FMPTrade => ({
  firstName: "Jane", lastName: "Doe", type: "Purchase", amount: "$1,001 - $15,000",
  symbol: `S${n++}`, transactionDate: daysAgo(3), link: `https://example.test/${n}.pdf`, ...o,
});

const scored = (t: FMPTrade, committee = false): AnalyzedTrade => ({
  trade: t, chamber: "house",
  trader: { id: "x", firstName: "Jane", lastName: "Doe", chamber: "house", committees: [] },
  score: { overallScore: 50, factors: {} as never, explanation: {}, flags: { ...NO_FLAGS, hasCommitteeRelevance: committee } },
});

// 30 recent purchases, 5 old ones, and one old purchase disclosed since the last report
const recent = Array.from({ length: 30 }, (_, i) => trade({ transactionDate: daysAgo(1 + (i % 25)) }));
const old = Array.from({ length: 5 }, () => trade({ transactionDate: daysAgo(60) }));
const lateFiled = trade({ transactionDate: daysAgo(50) });
const committeeBuy = recent[0];
const committeeSale = trade({ type: "Sale (Full)" });
const purchases = [...recent, ...old, lateFiled];

const report = {
  generatedAt: new Date().toISOString(),
  totalTradesAnalyzed: purchases.length + 1,
  scoredTrades: [...purchases.map((t) => scored(t, t === committeeBuy)), scored(committeeSale, true)],
} as unknown as AnalysisReport;

const html = buildHtmlReport({
  report,
  purchaseTrades: purchases.map((t) => ({ trade: t, party: "Democrat" })),
  salesTrades: [{ trade: committeeSale, party: "Democrat" }],
  dateLabel: "Today", dateStr: daysAgo(0),
  isNewlyDisclosed: (t) => t === lateFiled,
  previousRunLabel: "Yesterday",
});

test("Every trade lists the last 30 days plus newly disclosed trades, 25 at a time", async ({ page }) => {
  await page.setContent(html);
  await expect(page.locator('[data-tab="tab-purchases"]')).toHaveText("Purchases 31");
  const rows = page.locator("#tab-purchases tbody tr");
  await expect(rows).toHaveCount(31);
  await expect(page.locator("#tab-purchases tbody tr:visible")).toHaveCount(25);
  await expect(page.locator("#tab-purchases .table-count")).toHaveText("Showing 25 of 31");

  await page.locator("#tab-purchases .table-more").click();
  await expect(page.locator("#tab-purchases tbody tr:visible")).toHaveCount(31);
  await expect(page.locator("#tab-purchases .table-more")).toBeHidden();
  await expect(page.locator("#tab-purchases .row-new")).toHaveCount(1);
});

test("the side picker switches the ranking between purchases, sales and both", async ({ page }) => {
  await page.setContent(html);
  await expect(page.locator("#unusual-h")).toContainText("Most unusual");
  await page.locator('[data-view="committee"]').click();
  const visible = page.locator('[data-list="committee"] .pick:visible .tick');
  await expect(visible).toHaveText([committeeBuy.symbol!]);
  await expect(page.locator("#ranked-csv")).toHaveAttribute("data-csv-section", "committee-purchase");

  await page.locator("#unusual-side").selectOption("sale");
  await expect(visible).toHaveText([committeeSale.symbol!]);
  await expect(page.locator("#ranked-csv")).toHaveAttribute("data-csv-section", "committee-sale");

  await page.locator("#unusual-side").selectOption("both");
  await expect(visible).toHaveCount(2);

  // The full list has no sales but the one, and says so for purchases-only views it cannot fill
  await page.locator('[data-view="top"]').click();
  await page.locator("#unusual-side").selectOption("sale");
  await expect(page.locator('[data-list="top"] .pick:visible')).toHaveCount(1);
});

test("the side picker is remembered", async ({ page }) => {
  await page.route("http://site.test/r.html", (r) => r.fulfill({ contentType: "text/html", body: html }));
  await page.goto("http://site.test/r.html");
  await page.locator("#unusual-side").selectOption("sale");
  await page.reload();
  await expect(page.locator("#unusual-side")).toHaveValue("sale");
});

test("an empty side says which side it is", async ({ page }) => {
  const noSales = buildHtmlReport({
    report: { ...report, scoredTrades: report.scoredTrades.filter((t) => t.trade !== committeeSale) } as AnalysisReport,
    purchaseTrades: [], salesTrades: [], dateLabel: "Today", dateStr: daysAgo(0),
  });
  await page.setContent(noSales);
  await page.locator("#unusual-side").selectOption("sale");
  await expect(page.locator('[data-list="top"] .empty')).toHaveText("No sales in the last 30 days scored high enough to rank.");
});
