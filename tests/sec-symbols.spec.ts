import { test, expect } from "@playwright/test";
import { buildSymbolDirectory, checkTicker, findByName, namesMatch, nameTokens } from "../src/data/sec-symbols.js";
import { applyTickerCheck } from "../src/ocr/ocr-filings.js";

// Entries as the SEC lists them, in its order (main ticker first)
const dir = buildSymbolDirectory(
  [
    { ticker: "WMT", cik: 104169, title: "Walmart Inc." },
    { ticker: "VUZI", cik: 1463972, title: "Vuzix Corp" },
    { ticker: "MRSH", cik: 62709, title: "MARSH & MCLENNAN COMPANIES, INC." },
    { ticker: "GS", cik: 886982, title: "GOLDMAN SACHS GROUP INC" },
    { ticker: "GLDM", cik: 1222333, title: "World Gold Trust" },
    { ticker: "GOOGL", cik: 1652044, title: "Alphabet Inc." },
    { ticker: "GOOG", cik: 1652044, title: "Alphabet Inc." },
    { ticker: "GM", cik: 1467858, title: "General Motors Co" },
    { ticker: "GIS", cik: 40704, title: "GENERAL MILLS INC" },
    { ticker: "IBM", cik: 51143, title: "INTERNATIONAL BUSINESS MACHINES CORP" },
    { ticker: "XOM", cik: 34088, title: "EXXON MOBIL CORP" },
    { ticker: "TJX", cik: 109198, title: "TJX COMPANIES INC /DE/" },
  ],
  ["IVV", "VOO"]
);

test("names reduce to the words that identify the company", () => {
  expect(nameTokens("Walmart Inc. - Common Stock (WMTD) [ST]")).toEqual(["WALMART"]);
  expect(nameTokens("TJX COMPANIES INC (NEW) CMN")).toEqual(["TJX"]);
  expect(nameTokens("TJX COMPANIES INC /DE/")).toEqual(["TJX"]);
});

test("names match on shared words or spelling, not just a first word", () => {
  expect(namesMatch("Marsh Common Stock (MRSH)", "MARSH & MCLENNAN COMPANIES, INC.")).toBe(true);
  expect(namesMatch("ExxonMobil Holdings Corporation Common Stock (XOM)", "EXXON MOBIL CORP")).toBe(true);
  expect(namesMatch("General Motors Company", "GENERAL MILLS INC")).toBe(false);
});

test("a name finds its company's main ticker, and only when unambiguous", () => {
  expect(findByName(dir, "ALPHABET INC. CLASS A")?.ticker).toBe("GOOGL");
  expect(findByName(dir, "INTL BUSINESS MACHINES CORP CMN")?.ticker).toBe("IBM");
  expect(findByName(dir, "General")).toBeUndefined();
});

test("a listed ticker whose company matches the name is verified", () => {
  expect(checkTicker(dir, "Marsh Common Stock (MRSH)", "MRSH")).toEqual({ symbol: "MRSH", check: "verified" });
  expect(checkTicker(dir, "iShares Core S&P 500 ETF", "IVV")).toEqual({ symbol: "IVV", check: "fund" });
});

test("a misread ticker is corrected from the company name", () => {
  expect(checkTicker(dir, "Walmart Inc. - Common Stock (WMTD)", "WMTD")).toEqual({ symbol: "WMT", check: "corrected" });
  expect(checkTicker(dir, "Vuzix Corporation (VUZX)", "VUZX")).toEqual({ symbol: "VUZI", check: "corrected" });
  expect(checkTicker(dir, "General Motors Company", "GIS")).toEqual({ symbol: "GM", check: "corrected" });
});

test("a missing ticker is found by name", () => {
  expect(checkTicker(dir, "TJX COMPANIES INC (NEW) CMN", undefined)).toEqual({ symbol: "TJX", check: "found-by-name" });
  expect(checkTicker(dir, "MH Built to Last LLC", undefined)).toEqual({});
});

test("a listed ticker for another company stays only if the filing writes it", () => {
  expect(checkTicker(dir, "World Gold Tr Spdr Gold Minishares - GLDM", "GLDM")).toEqual({ symbol: "GLDM", check: "verified" });
  expect(checkTicker(dir, "Spdr Gold Minishares GLDM", "GLDM")).toEqual({ symbol: "GLDM", check: "name-mismatch" });
  expect(checkTicker(dir, "OKLAHOMA CITY OKLA ARPT TRUST REV BDS", "GS")).toEqual({ check: "rejected" });
  expect(checkTicker(dir, "Unlisted Widgets", "ZZZZ")).toEqual({ symbol: "ZZZZ", check: "unknown-symbol" });
});

test("re-checking a trade starts from the ticker as read", () => {
  const once = applyTickerCheck({ assetDescription: "Walmart Inc. - Common Stock (WMTD)", symbol: "WMTD", source: "ocr" }, dir);
  expect(once).toMatchObject({ symbol: "WMT", tickerCheck: "corrected", ocrTicker: "WMTD" });
  expect(applyTickerCheck(once, dir)).toEqual(once);

  const rejected = applyTickerCheck({ assetDescription: "TULSA OKLA UTIL REV BDS", symbol: "GS", source: "ocr" }, dir);
  expect(rejected).not.toHaveProperty("symbol");
  expect(applyTickerCheck(rejected, dir)).toEqual(rejected);
});
