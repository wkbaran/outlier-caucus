import { test, expect } from "@playwright/test";
import { groupBy, sumAmounts } from "../src/services/trade-groups.js";
import { buildAnalysis } from "../src/services/analysis-service.js";
import { buildHtmlReport } from "../src/output/html.js";
import { buildBrief } from "../src/output/brief.js";
import { DEFAULT_SCORING_CONFIG } from "../src/scoring/index.js";
import type { FMPTrade } from "../src/types/index.js";

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

const trade = (o: Partial<FMPTrade>): FMPTrade => ({
  firstName: "Jane", lastName: "Doe", type: "Purchase", amount: "$1,001 - $15,000", owner: "Self",
  transactionDate: daysAgo(5), dateRecieved: "9/20/2026", link: "https://example.test/a.pdf", ...o,
});

// Jane splits one ACME buy into three lots on one day, then buys ACME again a
// week later; she also has two ordinary trades in other stocks.
const lots = [
  trade({ symbol: "ACME" }),
  trade({ symbol: "ACME", owner: "Spouse", link: "https://example.test/b.pdf" }),
  trade({ symbol: "ACME" }),
];
const later = trade({ symbol: "ACME", transactionDate: daysAgo(12) });
const others = [trade({ symbol: "XYZ", transactionDate: daysAgo(40) }), trade({ symbol: "QRS", transactionDate: daysAgo(50) })];
const house = [...lots, later, ...others];

test("groups a key's items while each is within the gap of the one before", () => {
  const items = [
    { k: "a", d: "2026-09-01" }, { k: "a", d: "2026-09-01" }, { k: "a", d: "2026-09-03" },
    { k: "a", d: "2026-09-05" }, { k: null, d: "2026-09-01" }, { k: "b", d: "2026-09-01" },
  ];
  const sizes = (gap: number) => groupBy(items, (i) => i.k, (i) => i.d, gap).map((g) => g.length);
  expect(sizes(0)).toEqual([2, 1, 1, 1, 1]);
  expect(sizes(2)).toEqual([4, 1, 1]);
});

test("adds up disclosed amount bands", () => {
  expect(sumAmounts(["$1,001 - $15,000", "$1,001 - $15,000", undefined])).toBe("$2,002 - $30,000");
  expect(sumAmounts(["$15,001 - $50,000", "Over $50,000,000"])).toBe("Over $50,015,001");
  expect(sumAmounts([undefined])).toBeNull();
});

test("a same-day group is scored once, as one trade of its total size", async () => {
  const report = await buildAnalysis([], house, null, null);
  const acme = report.scoredTrades.filter((t) => t.trade.symbol === "ACME");
  const grouped = acme.filter((t) => t.groupId);
  expect(grouped).toHaveLength(3);
  expect(new Set(grouped.map((t) => t.groupId)).size).toBe(1);
  expect(new Set(grouped.map((t) => t.score)).size).toBe(1);
  expect(acme.find((t) => t.trade === later)?.groupId).toBeUndefined();

  const { explanation, flags } = grouped[0].score;
  // Three lots of $8,000.50 at the midpoint
  expect(explanation.conviction?.tradeSize).toBe(24001.5);
  // Her usual size counts the group once: (24001.5 + 3 × 8000.5) / 4
  expect(explanation.conviction?.averageSize).toBeCloseTo(12000.75, 2);
  // Congress bought ACME twice (the group and the later buy), not four times
  expect(explanation.rarity?.totalCongressTrades).toBe(2);
  // The spouse's lot makes the group indirect
  expect(flags.isIndirectOwnership).toBe(true);
});

test("trades without a ticker group only on the exact same asset description", async () => {
  const fund = { symbol: undefined, assetType: "Other", transactionDate: daysAgo(3) };
  const report = await buildAnalysis([], [
    trade({ ...fund, assetDescription: "Not Fade Away LLC (Hedge Fund)" }),
    trade({ ...fund, assetDescription: "not fade away  LLC (Hedge Fund)" }),
    trade({ ...fund, assetDescription: "GRAND RIVER DAM AUTH REV BDS 2029" }),
    trade({ ...fund, assetDescription: "GRAND RIVER DAM AUTH REV BDS 2034" }),
  ], null, null);
  expect(report.scoredTrades.map((t) => !!t.groupId)).toEqual([true, true, false, false]);
});

test("a wider gap pulls the later buy into the group", async () => {
  const report = await buildAnalysis([], house, null, null, { ...DEFAULT_SCORING_CONFIG, grouping: { maxGapDays: 7 } });
  expect(report.scoredTrades.filter((t) => t.trade.symbol === "ACME" && t.groupId)).toHaveLength(4);
});

test("the ranked list, new-trade count and brief show a group as one trade", async ({ page }) => {
  const report = await buildAnalysis([], house, null, null);
  const isNewlyDisclosed = (t: FMPTrade) => lots.includes(t);
  const purchaseTrades = house.map((t) => ({ trade: t, party: "Democrat" }));
  const html = buildHtmlReport({
    report, purchaseTrades, salesTrades: [], dateLabel: "October 1, 2026", dateStr: "2026-10-01",
    isNewlyDisclosed, previousRunLabel: "September 30, 2026",
  });
  await page.setContent(html);

  const picks = page.locator('[data-list="top"] .pick');
  await expect(picks).toHaveCount(2);
  const group = page.locator('[data-list="top"] .pick.grouped');
  await expect(group).toHaveCount(1);
  await expect(group.locator(".amt")).toContainText("3 trades");
  await expect(group.locator(".amt")).toContainText("$3K–$45K");
  await group.locator(".more").click();
  await expect(group.locator(".lots tbody tr")).toHaveCount(3);
  await expect(group.locator(".lots a")).toHaveCount(3);

  await expect(page.locator("#fresh-h")).toContainText("disclosed 1 trade since");
  await expect(page.locator(".filing-list li")).toHaveCount(1);
  await expect(page.locator(".filing-list .when")).toContainText("3 trades");

  const brief = buildBrief({
    report, trades: house, isNewlyDisclosed, hasPrevious: true, filingBaseline: "2026-09-15", foundAfter: null,
    reportDate: "2026-10-01", reportLabel: "October 1, 2026", resolveParty: () => "Democrat",
    memberLink: () => null, topWindowDays: 30,
  });
  expect(brief.summary.newTrades).toBe(1);
  expect(brief.newFilings[0]).toMatchObject({ tradeCount: 3, amount: "$3,003 - $45,000" });
  expect(brief.newFilings[0].trades).toHaveLength(3);
  const top = brief.topPurchases.find((e) => e.tradeCount === 3);
  expect(top?.amountRange).toEqual({ low: 3003, high: 45000 });
});
