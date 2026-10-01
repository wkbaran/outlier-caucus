import { test, expect } from "@playwright/test";
import { buildBrief, amountRange, BRIEF_SCHEMA } from "../src/output/brief.js";
import { createNewlyDisclosedPredicate } from "../src/utils/filing-date.js";
import type { AnalysisReport, AnalyzedTrade } from "../src/services/analysis-service.js";
import type { FMPTrade } from "../src/types/index.js";

const trade = (o: Partial<FMPTrade>): FMPTrade => ({
  firstName: "Jane", lastName: "Doe", type: "Purchase", amount: "$1,001 - $15,000",
  transactionDate: "2026-09-01", dateRecieved: "9/20/2026", link: "https://example.test/f.pdf", ...o,
});

const NO_FLAGS = { isSmallCap: false, isHighConviction: false, isRareStock: false, hasCommitteeRelevance: false, isDerivative: false, isIndirectOwnership: false };

const scored = (t: FMPTrade, overallScore: number, flags: Partial<typeof NO_FLAGS> = {}, explanation = {}): AnalyzedTrade => ({
  trade: t, chamber: "house",
  trader: { id: "x", firstName: t.firstName!, lastName: t.lastName!, chamber: "house", committees: [] },
  score: { overallScore, factors: {} as never, explanation, flags: { ...NO_FLAGS, ...flags } },
});

const old = trade({ symbol: "OLD", dateRecieved: "9/10/2026", transactionDate: "2026-09-15" });
const big = trade({ symbol: "ACME", amount: "$250,001 - $500,000", transactionDate: "2026-09-02" });
const small = trade({ symbol: "ACME", firstName: "John", lastName: "Roe", type: "Sale (Full)" });
const rare = trade({ symbol: "ZZZ", firstName: "John", lastName: "Roe", dateRecieved: "2026-09-21", source: "ocr" });
const trades = [old, big, small, rare];

const report = {
  generatedAt: "2026-09-25T13:00:00Z",
  scoredTrades: [
    scored(old, 80),
    scored(big, 40, { isHighConviction: true }, { conviction: { tradeSize: 375000, averageSize: 8000, multiplier: 46.9 } }),
    scored(small, 10),
    scored(rare, 60, { isRareStock: true }, { rarity: { totalCongressTrades: 1, uniqueTraders: 1, category: "unique" } }),
  ],
} as unknown as AnalysisReport;

const opts = {
  report, trades,
  isNewlyDisclosed: createNewlyDisclosedPredicate("2026-09-15"),
  hasPrevious: true,
  filingBaseline: "2026-09-15",
  foundAfter: null,
  previousReport: { date: "2026-09-16", label: "September 16, 2026" },
  reportDate: "2026-09-25", reportLabel: "September 25, 2026",
  resolveParty: () => "Democrat",
  memberLink: (t: FMPTrade) => `member-${t.lastName!.toLowerCase()}.html`,
  topWindowDays: 30,
};

test("lists only trades filed after the previous report, highest score first", () => {
  const brief = buildBrief(opts);
  expect(brief.schema).toBe(BRIEF_SCHEMA);
  expect(brief.newSince).toEqual({ previousReport: "2026-09-16", foundAfter: null, filedAfter: "2026-09-15" });
  expect(brief.newFilings.map((e) => e.symbol)).toEqual(["ZZZ", "ACME", "ACME"]);
  expect(brief.summary).toMatchObject({ newTrades: 3, purchases: 2, sales: 1, members: 2, symbols: 2 });
});

test("each new trade carries its reasons, dates and links", () => {
  const [first, second] = buildBrief(opts).newFilings;
  expect(first).toMatchObject({
    reasons: ["The only congressional trade in this asset"], flags: ["isRareStock"],
    filedDate: "2026-09-21", disclosureLagDays: 20, fromScannedFiling: true,
    memberPage: "2026-09-25/member-roe.html", filing: "https://example.test/f.pdf",
  });
  expect(second.reasons).toEqual(["46.9x this member's usual trade size"]);
  expect(second.amountRange).toEqual({ low: 250001, high: 500000 });
});

test("clusters a ticker that two members traded", () => {
  expect(buildBrief(opts).clusters).toEqual([
    { symbol: "ACME", asset: null, members: 2, trades: 2, buyers: ["Jane Doe"], sellers: ["John Roe"] },
  ]);
});

test("top purchases include older filings in the window", () => {
  expect(buildBrief(opts).topPurchases.map((e) => e.symbol)).toEqual(["OLD", "ZZZ", "ACME"]);
});

test("nothing is new on the first report", () => {
  const brief = buildBrief({ ...opts, hasPrevious: false, filingBaseline: null, isNewlyDisclosed: () => false, previousReport: undefined });
  expect(brief.newSince).toBeNull();
  expect(brief.newFilings).toEqual([]);
});

test("amount bands parse, including open-ended ones", () => {
  expect(amountRange("$1,001 - $15,000")).toEqual({ low: 1001, high: 15000 });
  expect(amountRange("Over $50,000,000")).toEqual({ low: 50000000, high: null });
  expect(amountRange(undefined)).toEqual({ low: null, high: null });
});

test("a late-posted filing shows how long it took to appear", () => {
  const late = trade({ symbol: "LATE", dateRecieved: "9/23/2026", firstSeen: "2026-09-29T00:03:58Z" });
  const [entry] = buildBrief({ ...opts, trades: [late], isNewlyDisclosed: () => true }).newFilings;
  expect(entry).toMatchObject({ filedDate: "2026-09-23", foundAt: "2026-09-29T00:03:58Z", postedLagDays: 6 });
});
