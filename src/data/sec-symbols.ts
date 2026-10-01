/**
 * The SEC's lists of listed company tickers (with company names) and fund share
 * class symbols, used to check tickers read by OCR against what actually exists
 * and against the company name written on the filing.
 *
 *   https://www.sec.gov/files/company_tickers.json     ticker, CIK, company name
 *   https://www.sec.gov/files/company_tickers_mf.json  fund and ETF symbols (no names)
 */
import { loadData, saveData } from "../utils/storage.js";

const COMPANIES_URL = "https://www.sec.gov/files/company_tickers.json";
const FUNDS_URL = "https://www.sec.gov/files/company_tickers_mf.json";
const CACHE_FILE = "sec-symbols.json";
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface SecCompany {
  ticker: string;
  cik: number;
  title: string;
}

interface CachedSymbols {
  companies: SecCompany[];
  funds: string[];
}

export interface SymbolDirectory {
  /** By ticker, with "." written as "-" the way the SEC writes share classes */
  companies: Map<string, SecCompany>;
  funds: Set<string>;
  /** By normalized company name; more than one entry means the name is ambiguous */
  byName: Map<string, SecCompany[]>;
  /** The same, with the words sorted: the SEC writes some names surname first ("SCHWAB CHARLES CORP") */
  bySortedName: Map<string, SecCompany[]>;
}

/** How an OCR'd ticker held up against the SEC lists. */
export type TickerCheck =
  | "verified"       // a listed company whose name matches the filing
  | "fund"           // a fund or ETF symbol (the SEC list has no names to compare)
  | "corrected"      // the read ticker was wrong or unknown; replaced by the one the name matches
  | "found-by-name"  // no ticker was read; found by the company name
  | "manual"         // set by hand in data/ticker-overrides.json
  | "name-mismatch"  // a listed ticker for a differently named company, kept because the filing writes it
  | "rejected"       // a listed ticker for a differently named company that the filing never writes; dropped
  | "unknown-symbol"; // not a listed company or fund, and the name matched nothing

const secKey = (ticker: string) => ticker.toUpperCase().replace(/\./g, "-");

// Words that describe the security or the legal form rather than name the company
const NAME_NOISE = new Set([
  "COMMON", "STOCK", "STOCKS", "SHARE", "SHARES", "ORDINARY", "CLASS", "BENEFICIAL", "INTEREST", "OF",
  "AMERICAN", "DEPOSITARY", "DEPOSITORY", "RECEIPT", "RECEIPTS", "SPONSORED", "UNSPONSORED",
  "ADR", "ADRS", "ADS", "UNIT", "UNITS", "NEW", "THE", "AND", "DEL", "DE",
  "INC", "INCORPORATED", "CORP", "CORPORATION", "CO", "COMPANY", "COMPANIES", "LTD", "LIMITED",
  "PLC", "LLC", "LP", "NV", "SA", "AG", "SE", "AS", "HOLDINGS", "HOLDING", "GROUP", "REGISTERED",
  // Broker statements: "MICROSOFT CORPORATION CMN", "MASTERCARD INCORPORATED CL A",
  // "COMCAST CORPORATION CMN CLASS A VOTING", "INFOSYS LTD SPON ADR EACH REP 1 ORD SHS"
  "CMN", "COM", "CL", "SPON", "SPONS", "UNSPONSORD", "SHS", "STK", "CAP", "ORD", "ORDS",
  "VOTING", "VTG", "NON", "EACH", "REP", "EQUALS",
]);

// Abbreviations broker statements use where the SEC spells the word out
const NAME_ABBREVIATIONS: Record<string, string> = {
  INTL: "INTERNATIONAL", TR: "TRUST", HLDG: "HOLDINGS", HLDGS: "HOLDINGS", COS: "COMPANIES",
  MFG: "MANUFACTURING", SVCS: "SERVICES", SVC: "SERVICES", NATL: "NATIONAL", FINL: "FINANCIAL",
};

const NOISE_WORDS = [...NAME_NOISE];

/** Significant words of a company or asset name: "Walmart Inc. - Common Stock [ST]" → ["WALMART"] */
export function nameTokens(text: string): string[] {
  const words = text
    .toUpperCase()
    .replace(/\([^)]*\)|\[[^\]]*\]|\/[A-Z]{2,3}\/?/g, " ")
    .replace(/\bUSD\s?[\d.]+/g, " ")
    // "S&P", "AT&T", "SS&C" are names, not two words
    .replace(/\b([A-Z]{1,2})\s?&\s?([A-Z]{1,2})\b/g, "$1$2")
    // "MOODY'S" is MOODYS; "O'REILLY" is O REILLY, as the SEC writes it
    .replace(/'S\b/g, "S")
    .replace(/[^A-Z0-9]+/g, " ")
    // Initials are one word: "U.S. BANCORP", "N V R INC", "A.O. SMITH"
    .replace(/\b[A-Z](?: [A-Z]\b)+/g, (m) => m.replace(/ /g, ""))
    .trim()
    .split(" ")
    .map((w) => NAME_ABBREVIATIONS[w] ?? w);
  // Statements cut names off at a column width: "UNITEDHEALTH GROUP INCORPORATE",
  // "TRANE TECHNOLOGIES PUBLIC LIMI". A last word that starts a legal-form word goes.
  while (words.length > 1) {
    const last = words[words.length - 1];
    if (NAME_NOISE.has(last) || /^\d+$/.test(last) || last.length < 2) { words.pop(); continue; }
    if (NOISE_WORDS.some((n) => n.length > last.length && n.startsWith(last))) { words.pop(); continue; }
    if (last === "PUBLIC") { words.pop(); continue; } // "PUBLIC LIMITED COMPANY", cut short
    break;
  }
  return words.filter((w) => w.length > 1 && !NAME_NOISE.has(w) && !/^\d+$/.test(w));
}

/**
 * One name's words all appear in the other's ("Marsh" and "MARSH & MCLENNAN"), or
 * one spells the other once spaces go ("ExxonMobil" and "EXXON MOBIL CORP"). A
 * shared first word is not enough: General Motors is not General Mills.
 */
export function namesMatch(asset: string, title: string): boolean {
  const a = nameTokens(asset);
  const b = nameTokens(title);
  if (!a.length || !b.length) return false;
  const [ja, jb] = [a.join(""), b.join("")];
  if (ja.startsWith(jb) || jb.startsWith(ja)) return true;
  const [sa, sb] = [new Set(a), new Set(b)];
  return a.every((w) => sb.has(w)) || b.every((w) => sa.has(w));
}

export function buildSymbolDirectory(companies: SecCompany[], funds: string[]): SymbolDirectory {
  const dir: SymbolDirectory = { companies: new Map(), funds: new Set(funds.map(secKey)), byName: new Map(), bySortedName: new Map() };
  const add = (index: Map<string, SecCompany[]>, name: string, company: SecCompany) => {
    const same = index.get(name) ?? [];
    if (!same.some((c) => c.cik === company.cik)) index.set(name, [...same, company]);
  };
  for (const company of companies) {
    const key = secKey(company.ticker);
    if (dir.companies.has(key)) continue;
    dir.companies.set(key, company);
    const words = nameTokens(company.title);
    if (!words.length) continue;
    // The SEC lists a company's main ticker first (GOOGL before GOOG, BRK-B before BRK-A),
    // so only the first ticker per company is kept for name lookups.
    add(dir.byName, words.join(" "), company);
    add(dir.bySortedName, [...words].sort().join(" "), company);
  }
  return dir;
}

/** The single company in a list of candidates, or undefined when there are none or several. */
function only(candidates: Iterable<SecCompany>): SecCompany | undefined {
  const ciks = new Map<number, SecCompany>();
  for (const c of candidates) ciks.set(c.cik, ciks.get(c.cik) ?? c);
  return ciks.size === 1 ? [...ciks.values()][0] : undefined;
}

// Bonds, notes and options carry their issuer's name, but the issuer's stock ticker
// isn't theirs: "VERIZON COMMUNICATIONS, INC. 4.329% 09/21/2028",
// "JPMORGAN CHASE & CO. LINKED TO S&P 500 INDEX"
const NOT_EQUITY = new RegExp(
  [
    "%", "\\d{1,2}/\\d{1,2}/\\d{2,4}", "\\bHYBRID\\b", "\\bPERPETUAL\\b", "\\bMTN\\b", "\\bLI?NKE?D TO\\b",
    "\\bBDS?\\b", "\\bBONDS?\\b", "\\bNOTES?\\b", "\\bREV\\b", "\\bGO\\b", "\\bPFD\\b", "\\bPREFERRED\\b",
    "\\bCALL\\b", "\\bPUT\\b", "\\bFLEX\\b", "\\bWARRANTS?\\b", "\\bMUNI", "\\bTAX[- ]EXEMPT\\b",
  ].join("|"),
  "i"
);
/** Described as a listed share ("CMN", "Common Stock", "ADR", "Class A") and not a bond, note or fund. */
export function looksLikeListedStock(asset: string): boolean {
  return /common stock|ordinary shares|\bCMN\b|\bADRS?\b|\bADS\b|\bCL(?:ASS)?[ -][A-C]\b|\bCOM\b|\bSHS\b/i.test(asset)
    && !NOT_EQUITY.test(asset) && !FUND.test(asset);
}

// A fund is only found by its exact name: "VANGUARD TOTAL STOCK MARKET INDEX FD" must
// not land on American Vanguard by a looser match.
const FUND = /\b(?:ETF|FUNDS?|FDS?|INDEX|TRUST)\b/i;

/**
 * The one listed company with this name, if there is exactly one. Tried in turn:
 * the same words; the same words in another order ("SCHWAB CHARLES CORP"); and a
 * name cut short on a statement ("BROADRIDGE FINANCIAL SOLUTIONS IN"), except for
 * funds. Ambiguity at any step means no answer, and bonds, notes and options never
 * get one.
 */
export function findByName(dir: SymbolDirectory, asset: string): SecCompany | undefined {
  if (NOT_EQUITY.test(asset)) return undefined;
  const words = nameTokens(asset);
  if (!words.length) return undefined;
  const key = words.join(" ");

  const exact = dir.byName.get(key) ?? dir.bySortedName.get([...words].sort().join(" "));
  if (exact) return only(exact);

  const joined = words.join("");
  if (joined.length < 8 || FUND.test(asset)) return undefined;
  const cutShort: SecCompany[] = [];
  for (const [name, companies] of dir.byName) {
    if (name.replace(/ /g, "").startsWith(joined)) cutShort.push(...companies);
  }
  return only(cutShort);
}

/**
 * Check an OCR'd ticker against the SEC lists and the asset name written on the
 * filing, correcting it when the name points to a different listed company.
 */
export function checkTicker(
  dir: SymbolDirectory,
  asset: string,
  ticker: string | undefined
): { symbol?: string; check?: TickerCheck } {
  const named = findByName(dir, asset);
  if (!ticker) return named ? { symbol: named.ticker, check: "found-by-name" } : {};

  const company = dir.companies.get(secKey(ticker));
  if (company) {
    if (namesMatch(asset, company.title) || named?.cik === company.cik) return { symbol: ticker, check: "verified" };
    if (named) return { symbol: named.ticker, check: "corrected" };
    // "GLDM" written into a gold trust's name is real; "GS" read off a municipal bond is
    // the government-securities code, and GS is Goldman Sachs.
    const written = new RegExp(`(^|[^A-Z])${ticker.replace(/[.-]/g, "[.-]")}([^A-Z]|$)`).test(asset.toUpperCase());
    return written ? { symbol: ticker, check: "name-mismatch" } : { check: "rejected" };
  }
  if (dir.funds.has(secKey(ticker))) return { symbol: ticker, check: "fund" };
  return named ? { symbol: named.ticker, check: "corrected" } : { symbol: ticker, check: "unknown-symbol" };
}

async function secFetch(url: string, userAgent: string): Promise<unknown> {
  const response = await fetch(url, { headers: { "User-Agent": userAgent, Accept: "application/json" } });
  if (!response.ok) throw new Error(`SEC ${response.status} ${response.statusText} (${url})`);
  return response.json();
}

let loaded: Promise<SymbolDirectory | null> | null = null;

/**
 * The directory from a cache refreshed weekly. Returns null, after a warning, when
 * there is neither a usable cache nor SEC access (SEC_USER_AGENT unset or offline),
 * so OCR still runs without ticker checks.
 */
export function loadSymbolDirectory(): Promise<SymbolDirectory | null> {
  loaded ??= (async () => {
    const stored = await loadData<CachedSymbols>(CACHE_FILE);
    const fresh = stored?.fetchedAt && Date.now() - new Date(stored.fetchedAt).getTime() < CACHE_TTL_MS;
    const userAgent = process.env.SEC_USER_AGENT;
    if (stored?.data && (fresh || !userAgent)) return buildSymbolDirectory(stored.data.companies, stored.data.funds);
    if (!userAgent) {
      console.warn("⚠️  SEC_USER_AGENT is not set, so OCR'd tickers are not checked against the SEC symbol lists");
      return null;
    }
    try {
      const companies = Object.values(await secFetch(COMPANIES_URL, userAgent) as Record<string, { cik_str: number; ticker: string; title: string }>)
        .map((c) => ({ ticker: c.ticker.toUpperCase(), cik: c.cik_str, title: c.title }));
      const mf = await secFetch(FUNDS_URL, userAgent) as { fields: string[]; data: unknown[][] };
      const symbolAt = mf.fields.indexOf("symbol");
      const funds = mf.data.map((row) => String(row[symbolAt] ?? "")).filter(Boolean);
      await saveData(CACHE_FILE, { companies, funds });
      return buildSymbolDirectory(companies, funds);
    } catch (err) {
      console.warn(`⚠️  Could not refresh the SEC symbol lists: ${(err as Error).message}`);
      return stored?.data ? buildSymbolDirectory(stored.data.companies, stored.data.funds) : null;
    }
  })();
  return loaded;
}
