import { test, expect } from "@playwright/test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { buildAttention } from "../src/output/attention.js";
import { buildHtmlReport } from "../src/output/html.js";
import { buildSymbolDirectory } from "../src/data/sec-symbols.js";
import { applyTickerCheck, loadTickerOverrides, type OcrFilingRecord } from "../src/ocr/ocr-filings.js";
import type { AnalysisReport } from "../src/services/analysis-service.js";
import type { FMPTrade } from "../src/types/index.js";

const url = "https://example.test/9116256.pdf";
const record = (status: OcrFilingRecord["status"]): OcrFilingRecord => ({
  chamber: "house", id: "9116256", member: "Diana Harshbarger", url, filingDate: "8/3/2026", model: "m", status,
  pageCount: 2, pages: [
    { page: 1, rotation: 0, attempts: 1, seconds: 1, status: "ok", quality: 1, validRows: 3, rejectedRows: 0, skippedRows: 0 },
    { page: 2, rotation: 0, attempts: 1, seconds: 1, status: "needs-review", quality: 0.5, validRows: 1, rejectedRows: 1, skippedRows: 0 },
  ] as never, trades: 4, merged: true, artifactDir: "logs\\ocr\\house-9116256", startedAt: "", finishedAt: "",
});

const unresolved: FMPTrade = { firstName: "Ro", lastName: "Khanna", source: "ocr", assetDescription: "APLOVIN CORPORATION CMN CLASS A", dateRecieved: "9/28/2026" };
const bond: FMPTrade = { firstName: "Ro", lastName: "Khanna", source: "ocr", assetDescription: "TULSA OKLA UTIL REV BDS 3.0% 04/01/2029" };
const fromScan: FMPTrade = { firstName: "Diana", lastName: "Harshbarger", source: "ocr", link: url, symbol: "XOM", tickerCheck: "verified" };

const inputs = {
  trades: [unresolved, unresolved, bond, fromScan],
  isNewlyDisclosed: (t: FMPTrade) => t.dateRecieved === "9/28/2026",
  ocrResults: { "house:9116256": record("needs-review") },
  pendingFilings: [{ chamber: "house" as const, id: "1", member: "Max Miller", filingDate: "9/27/2026", url: "u", reason: "scanned PDF (image-only)" }],
  tickerChecksOn: true,
  reportDate: "2026-09-29",
};

test("lists what couldn't be resolved, this report's first, each with a fix", () => {
  const items = buildAttention(inputs);
  expect(items.map((i) => i.kind)).toEqual(["ticker-unresolved", "ocr-needs-review", "ocr-pending"]);
  const [ticker, review, pending] = items;
  expect(ticker).toMatchObject({ inThisReport: true, trades: 2, asset: "APLOVIN CORPORATION CMN CLASS A" });
  expect(ticker.fix[0]).toContain('`{"APLOVIN CORPORATION CMN CLASS A":"TICKER"}`');
  expect(review).toMatchObject({ inThisReport: false, trades: 1, filing: url });
  expect(review.fix[0]).toBe("Compare `logs/ocr/house-9116256/page-2.png` with the filing.");
  expect(review.fix[1]).toContain("ocr:catchup --retry --filing 9116256");
  expect(pending.fix[1]).toContain("--date 2026-09-29");
});

test("a failed filing and missing SEC lists are reported", () => {
  const items = buildAttention({ ...inputs, trades: [], pendingFilings: [], tickerChecksOn: false, ocrResults: { "house:9116256": record("failed") } });
  expect(items.map((i) => i.kind)).toEqual(["ticker-checks-off", "ocr-failed"]);
});

test("a hand-set ticker overrides the checks, and \"\" clears one", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ovr-")), "ticker-overrides.json");
  fs.writeFileSync(file, JSON.stringify({ "aplovin corporation  cmn class a": "app", "MH Built to Last LLC": "" }));
  const overrides = await loadTickerOverrides(file);
  const dir = buildSymbolDirectory([], []);
  expect(applyTickerCheck(unresolved, dir, overrides)).toMatchObject({ symbol: "APP", tickerCheck: "manual" });
  const cleared = applyTickerCheck({ source: "ocr", assetDescription: "MH Built to Last LLC", symbol: "MH" }, dir, overrides);
  expect(cleared).not.toHaveProperty("symbol");
  expect(cleared.tickerCheck).toBe("manual");
  expect(buildAttention({ ...inputs, trades: [{ ...unresolved, symbol: "APP", tickerCheck: "manual" }], ocrResults: {}, pendingFilings: [] })).toEqual([]);
});

test("the report lists them at the foot, with commands as code", async ({ page }) => {
  const report = {
    generatedAt: "2026-09-29T13:00:00Z", totalTradesAnalyzed: 0, scoredTrades: [],
    summary: { topByScore: [], byRarity: [], byCommitteeRelevance: [], symbolStats: {} },
  } as unknown as AnalysisReport;
  const build = (attention: ReturnType<typeof buildAttention>) => buildHtmlReport({
    report, salesTrades: [], purchaseTrades: [], dateLabel: "September 29, 2026", dateStr: "2026-09-29", attention,
  });

  await page.setContent(build(buildAttention(inputs)));
  await expect(page.locator("#checks .check-list > li")).toHaveCount(3);
  await expect(page.locator("#checks .check-new")).toHaveCount(1);
  await expect(page.locator(".fresh-check a")).toHaveAttribute("href", "#checks");
  await page.locator("#checks summary").first().click();
  await expect(page.locator("#checks .fix code").nth(1)).toHaveText('{"APLOVIN CORPORATION CMN CLASS A":"TICKER"}');

  await page.setContent(build([]));
  await expect(page.locator("#checks")).toHaveCount(0);
});
