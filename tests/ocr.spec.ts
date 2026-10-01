import { test, expect } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import {
  normalizeAmount, normalizeDate, normalizeType, validateRows, rowTicker, pageQuality, parseModelResponse,
} from "../src/ocr/ocr-page.js";
import { pagesFromDocument, rotationCandidates } from "../src/ocr/render.js";
import { earliestPlausibleDate, enabledOcrChambers, mergeOcrTrades, type FilingOcrOutcome } from "../src/ocr/ocr-filings.js";

test("OCR covers House and Senate scans by default, and OCR_CHAMBERS can narrow it", () => {
  expect(enabledOcrChambers({})).toEqual(["house", "senate"]);
  expect(enabledOcrChambers({ OCR_CHAMBERS: "senate" })).toEqual(["senate"]);
  expect(enabledOcrChambers({ OCR_CHAMBERS: " House , bogus " })).toEqual(["house"]);
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NOW = new Date("2026-09-13T12:00:00");

test("amounts normalize from printed ranges, spaced digits, letters, and over-limits", () => {
  expect(normalizeAmount("$15,001 - $50,000")).toBe("$15,001 - $50,000");
  expect(normalizeAmount("$1 000-$15 000")).toBe("$1,001 - $15,000");
  expect(normalizeAmount("$500,001 - $1,000,000")).toBe("$500,001 - $1,000,000");
  expect(normalizeAmount("D")).toBe("$100,001 - $250,000");
  expect(normalizeAmount("Over $50,000,000")).toBe("Over $50,000,000");
  expect(normalizeAmount("Over $1,000,000***")).toBe("Spouse/DC Over $1,000,000");
  // A lower bound that doesn't match its upper bound means the model mixed up columns
  expect(normalizeAmount("$15,001 - $100,000")).toBeUndefined();
  expect(normalizeAmount("$12,345")).toBeUndefined();
  expect(normalizeAmount(null)).toBeUndefined();
});

test("dates accept form styles and reject impossible or implausible ones", () => {
  expect(normalizeDate("03/16/2026", NOW)).toBe("2026-03-16");
  expect(normalizeDate("7/21/26", NOW)).toBe("2026-07-21");
  expect(normalizeDate("03/31/26", NOW)).toBe("2026-03-31");
  expect(normalizeDate("02/30/2026", NOW)).toBeUndefined();
  expect(normalizeDate("12/01/2026", NOW)).toBeUndefined(); // future
  expect(normalizeDate("01/01/2011", NOW)).toBeUndefined(); // before the STOCK Act regime
  expect(normalizeDate("", NOW)).toBeUndefined();
});

test("transaction types normalize, including partial sales", () => {
  expect(normalizeType("P")).toBe("Purchase");
  expect(normalizeType("S")).toBe("Sale (Full)");
  expect(normalizeType("S (partial)")).toBe("Sale (Partial)");
  expect(normalizeType("Exchange")).toBe("Exchange");
  expect(normalizeType("?")).toBeUndefined();
});

test("validation skips header rows, rejects unreadable rows, and strips Senate owner prefixes", () => {
  const result = validateRows([
    { owner: "SP", asset: "LLM FAMILY INVESTMENTS LP", type: null, transactionDate: null, amount: null },
    { owner: "SP", asset: "INTUIT INC", type: "P", transactionDate: "03/20/2026", amount: "$1,001 - $15,000" },
    { owner: null, asset: "(S) MH Four Winds LLC", type: "P", transactionDate: "7/21/26", amount: "$1,001 - $15,000" },
    { owner: "SP", asset: "BOSTON SCIENTIFIC CORP", type: "P", transactionDate: "3/2?/2026", amount: "$1,001 - $15,000" },
    { owner: "SP", asset: "Apple Inc (AAPL)", type: "S", transactionDate: "03/04/2026", amount: "$15,001 - $50,000" },
  ], NOW);

  expect(result.skipped).toBe(1);
  expect(result.valid).toHaveLength(3);
  expect(result.rejected).toHaveLength(1);
  expect(result.rejected[0].problems[0]).toContain("date");

  const senate = result.valid.find((r) => r.asset === "MH Four Winds LLC");
  expect(senate?.owner).toBe("Spouse");
  expect(senate?.transactionDate).toBe("2026-07-21");
  expect(result.valid.find((r) => r.asset.startsWith("Apple"))?.ticker).toBe("AAPL");
  expect(pageQuality(result, true)).toBe(0.75);
  expect(pageQuality({ valid: [], rejected: [], skipped: 0 }, true)).toBe(1);
});

test("the forms' printed example rows are never treated as transactions", () => {
  // Real OCR output from Harold Rogers, docId 9116218: the House form's sample row validated as a 2012 trade
  const result = validateRows([
    { asset: "Example Mega Corp Common Stock", type: "P", transactionDate: "08/14/2012", amount: "$50,001 - $100,000" },
    { asset: "IBM Corp. (stock) NYSE EXAMPLE", type: "P", transactionDate: "2/1/13", amount: "$15,001 - $50,000" },
    { asset: "Examplar Holdings Inc", type: "P", transactionDate: "03/02/2026", amount: "$1,001 - $15,000" },
  ], NOW);
  expect(result.skipped).toBe(2);
  expect(result.valid.map((r) => r.asset)).toEqual(["Examplar Holdings Inc"]);

  // Khanna cover pages carry a note row, dated with the form's example date
  expect(validateRows([{ asset: "Please see the attached.", type: "P", transactionDate: "2/5/15", amount: "$15,001 - $50,000" }], NOW).skipped).toBe(1);
});

test("dates implausibly long before the filing are rejected as misreads", () => {
  // Real OCR output from Diana Harshbarger, docId 9116256 (filed 8/3/2026): an Exxon row read as 2020
  const earliest = earliestPlausibleDate("8/3/2026");
  expect(earliest).toBe("2023-08-03");
  expect(earliestPlausibleDate("")).toBeUndefined();

  const result = validateRows([
    { asset: "Exxon Mobil Corp Comm Stock", type: "P", transactionDate: "02/05/2020", amount: "$15,001 - $50,000" },
    { asset: "Southeast Energy Auth Co RV", type: "P", transactionDate: "07/17/2026", amount: "$15,001 - $50,000" },
  ], NOW, earliest);
  expect(result.valid.map((r) => r.asset)).toEqual(["Southeast Energy Auth Co RV"]);
  expect(result.rejected[0].problems[0]).toContain("implausibly long before");
});

test("model responses parse from strict JSON, fenced JSON, or a bare array", () => {
  expect(parseModelResponse('{"page_readable": false, "rows": []}')).toEqual({ readable: false, rows: [] });
  expect(parseModelResponse('```json\n{"page_readable": true, "rows": [{"asset": "X"}]}\n```')?.rows).toHaveLength(1);
  expect(parseModelResponse('[{"asset": "X"}]')?.readable).toBe(true);
  expect(parseModelResponse("I could not read this page.")).toBeNull();
});

test("scanned PDF pages render, and sideways pages are rotated before OCR", () => {
  // Real filing: Michael McCaul, docId 9115728 — five scanned pages, two stored sideways
  const pages = pagesFromDocument(fs.readFileSync(path.join(__dirname, "fixtures", "house-ptr-scanned.pdf")), "application/pdf");
  expect(pages).toHaveLength(5);
  expect(pages.map((p) => p.portrait)).toEqual([false, true, false, false, true]);

  expect(rotationCandidates(true, true)).toEqual([270, 90]); // sideways House page
  expect(rotationCandidates(false, true)).toEqual([0, 180]);
  expect(rotationCandidates(true, false)).toEqual([0, 180]); // upright Senate page

  const upright = pages[1].render(270);
  expect(upright.width).toBeGreaterThan(upright.height);
  expect(upright.png.subarray(1, 4).toString()).toBe("PNG");
});

test("OCR merge replaces stored rows only for fully successful filings", () => {
  const url = "https://example.test/ptr.pdf";
  const stored = () => ({
    senateTrades: [],
    houseTrades: [{ link: url, symbol: "OLD" }, { link: "https://example.test/other.pdf", symbol: "KEEP" }],
  });
  const outcome = (status: "done" | "needs-review"): FilingOcrOutcome => ({
    record: {
      chamber: "house", id: "1", member: "A B", url, filingDate: "", model: "m", status, pageCount: 1,
      pages: [], trades: 1, merged: false, artifactDir: "", startedAt: "", finishedAt: "",
    },
    trades: [{ link: url, symbol: "NEW", source: "ocr" }],
  });

  const done = stored();
  expect(mergeOcrTrades(done, outcome("done"))).toBe(true);
  expect(done.houseTrades.map((t) => t.symbol)).toEqual(["KEEP", "NEW"]);

  const partial = stored();
  expect(mergeOcrTrades(partial, outcome("needs-review"))).toBe(false);
  expect(partial.houseTrades.map((t) => t.symbol)).toEqual(["OLD", "KEEP"]);
});

// From House filing 20035491, where the model put the asset-type code in the ticker field
test("the ticker written in the asset name beats the model's ticker field", () => {
  expect(rowTicker("Marsh Common Stock (MRSH)", "ST")).toBe("MRSH");
  expect(rowTicker("Vuzix Corporation (VUZX)", "ST")).toBe("VUZX");
  expect(rowTicker("Boston Scientific Corporation Common Stock (BSX) [ST]", "BSX")).toBe("BSX");
});

test("a model ticker that is the row's asset-type code is dropped", () => {
  expect(rowTicker("Some Private Fund LP [ST]", "ST")).toBeUndefined();
  expect(rowTicker("Coca-Cola Company", "KO")).toBe("KO");
});

test("share-class codes and name suffixes are not tickers", () => {
  expect(rowTicker("AMERIPRISE FINANCIAL, INC.", "CMN")).toBeUndefined();
  expect(rowTicker("TJX COMPANIES INC (NEW)", "CMN")).toBeUndefined();
  expect(rowTicker("WALT DISNEY COMPANY (THE)", "DIS")).toBe("DIS");
});
