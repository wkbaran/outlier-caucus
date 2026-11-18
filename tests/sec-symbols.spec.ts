import { test, expect } from "@playwright/test";
import { buildSymbolDirectory, checkTicker, findByName, mergeSymbolLists, namesMatch, nameTokens } from "../src/data/sec-symbols.js";
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
    { ticker: "UNH", cik: 731766, title: "UNITEDHEALTH GROUP INC" },
    { ticker: "SCHW", cik: 316709, title: "SCHWAB CHARLES CORP" },
    { ticker: "USB", cik: 36104, title: "US BANCORP DE" },
    { ticker: "TBBK", cik: 1295401, title: "Bancorp, Inc." },
    { ticker: "GLW", cik: 24741, title: "CORNING INC /NY" },
    { ticker: "VZ", cik: 732712, title: "VERIZON COMMUNICATIONS INC" },
    { ticker: "AVD", cik: 5981, title: "AMERICAN VANGUARD CORP" },
    { ticker: "IBIT", cik: 1980994, title: "iShares Bitcoin Trust ETF" },
    { ticker: "BR", cik: 1383312, title: "Broadridge Financial Solutions, Inc." },
    { ticker: "DPZ", cik: 1286681, title: "DOMINOS PIZZA INC" },
    { ticker: "CRH", cik: 849395, title: "CRH PUBLIC LTD CO" },
    { ticker: "KIM", cik: 879101, title: "KIMCO REALTY CORP" },
    { ticker: "OPBK", cik: 1431567, title: "OP Bancorp" },
    { ticker: "SAN", cik: 891478, title: "BANCO SANTANDER, S.A." },
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

test("statement quirks still find the company", () => {
  expect(findByName(dir, "UNITEDHEALTH GROUP INCORPORATE CMN")?.ticker).toBe("UNH");
  expect(findByName(dir, "BROADRIDGE FINANCIAL SOLUTIONS IN CMN")?.ticker).toBe("BR");
  expect(findByName(dir, "CHARLES SCHWAB CORPORATION CMN")?.ticker).toBe("SCHW");
  expect(findByName(dir, "U.S. BANCORP CMN")?.ticker).toBe("USB");
  expect(findByName(dir, "CORNING INCORPORATED CMN")?.ticker).toBe("GLW");
});

test("bonds, notes and funds don't take a company's stock ticker", () => {
  expect(findByName(dir, "VERIZON COMMUNICATIONS, INC. 4.329% 09/21/2028 USD")).toBeUndefined();
  expect(findByName(dir, "VERIZON COMMUNICATIONS INC HYBRID PERPETUAL")).toBeUndefined();
  expect(findByName(dir, "VANGUARD TOTAL STOCK MARKET INDEX FD ADMIRAL SHARES")).toBeUndefined();
  expect(findByName(dir, "ISHARES BITCOIN TRUST ETF")?.ticker).toBe("IBIT");
});

test("OCR spacing quirks in a name still find the company", () => {
  // A lost apostrophe leaves a stray S
  expect(findByName(dir, "DOMINO S PIZZA, INC. CMN")?.ticker).toBe("DPZ");
  // "PUBLIC LIMITED COMPANY" cut short and split
  expect(findByName(dir, "CRH PUBL C LIMITED COMPANY CMN")?.ticker).toBe("CRH");
  // An operating partnership takes its parent's ticker, but only at the end of the name
  expect(findByName(dir, "KIMCO REALTY OP LLC CMN")?.ticker).toBe("KIM");
  expect(findByName(dir, "OP BANCORP CMN")?.ticker).toBe("OPBK");
  // A stray S before the legal form is dropped as usual; only a failed lookup retries it as an apostrophe
  expect(nameTokens("INDUSTRIA DE DISENO TEXTIL S ADR CMN")).toEqual(["INDUSTRIA", "DISENO", "TEXTIL"]);
  expect(nameTokens("DOMINO S PIZZA, INC. CMN", true)).toEqual(["DOMINOS", "PIZZA"]);
  // "S A" is a legal form, not a lost apostrophe
  expect(nameTokens("BANCO SANTANDER S A ADR CMN")).toEqual(["BANCO", "SANTANDER"]);
  expect(findByName(dir, "BANCO SANTANDER S.A. ADR CMN")?.ticker).toBe("SAN");
});

test("accented letters match the SEC's plain spelling", () => {
  const withMdlz = buildSymbolDirectory([{ ticker: "MDLZ", cik: 1103982, title: "Mondelez International, Inc." }], []);
  expect(nameTokens("Mondelēz International, Inc. - Class A Common Stock (MDLZ)")).toEqual(["MONDELEZ", "INTERNATIONAL"]);
  expect(checkTicker(withMdlz, "Mondelēz International, Inc. - Class A Common Stock (MDLZ)", "MDLZ")).toEqual({ symbol: "MDLZ", check: "verified" });
});

test("an over-the-counter foreign share written on the filing is otc, not unknown", () => {
  expect(checkTicker(dir, "Tokyo Electron Ltd Ordinary Shares (TOELF) [ST]", "TOELF")).toEqual({ symbol: "TOELF", check: "otc" });
  expect(checkTicker(dir, "Bayer AG Sponsored ADR (BAYRY)", "BAYRY")).toEqual({ symbol: "BAYRY", check: "otc" });
  // Not written on the filing, or not the OTC shape: still unknown
  expect(checkTicker(dir, "Tokyo Electron Ltd Ordinary Shares", "TOELF").check).toBe("unknown-symbol");
  expect(checkTicker(dir, "ENGIE SA ORD (ENGF) [ST]", "ENGF").check).toBe("unknown-symbol");
});

test("a ticker that dropped off the SEC list still checks trades made while it was listed", () => {
  const before = { companies: [{ ticker: "WBD", cik: 1437107, title: "Warner Bros. Discovery, Inc." }, { ticker: "WMT", cik: 104169, title: "Walmart Inc." }], funds: ["IVV"] };
  const merged = mergeSymbolLists(before, [{ ticker: "WMT", cik: 104169, title: "Walmart Inc." }], ["VOO"]);
  expect(merged.retired).toEqual([{ ticker: "WBD", cik: 1437107, title: "Warner Bros. Discovery, Inc." }]);
  expect(merged.funds.sort()).toEqual(["IVV", "VOO"]);
  const after = buildSymbolDirectory(merged.companies, merged.funds, merged.retired);
  expect(checkTicker(after, "Warner Bros. Discovery, Inc. - Series A Common Stock (WBD)", "WBD")).toEqual({ symbol: "WBD", check: "verified" });
  // A ticker back on the list leaves the retired ones
  expect(mergeSymbolLists(merged, before.companies, []).retired).toEqual([]);
});

test("a retired company never takes a name lookup from a current one", () => {
  const d = buildSymbolDirectory(
    [{ ticker: "NEWCO", cik: 2, title: "Acme Widgets Inc" }],
    [],
    [{ ticker: "OLDCO", cik: 1, title: "Acme Widgets Corp" }, { ticker: "GONE", cik: 3, title: "Gone Away Industries" }]
  );
  expect(findByName(d, "ACME WIDGETS INC CMN")?.ticker).toBe("NEWCO");
  expect(findByName(d, "GONE AWAY INDUSTRIES CMN")?.ticker).toBe("GONE");
});

test("a name finds the common stock even when the SEC lists a preferred share first", () => {
  const d = buildSymbolDirectory([
    { ticker: "ARES.PRB", cik: 1176948, title: "Ares Management Corp" },
    { ticker: "ARES", cik: 1176948, title: "Ares Management Corp" },
    { ticker: "CHSCL", cik: 823277, title: "CHS INC" },
    { ticker: "CHSCP", cik: 823277, title: "CHS INC" },
  ], []);
  expect(findByName(d, "ARES MANAGEMENT CORPORATION CMN CLASS A")?.ticker).toBe("ARES");
  // Still found by its own ticker
  expect(checkTicker(d, "Ares Management Corp 6.75% Pfd Series B", "ARES.PRB").symbol).toBe("ARES.PRB");
});
