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
}

/** How an OCR'd ticker held up against the SEC lists. */
export type TickerCheck =
  | "verified"       // a listed company whose name matches the filing
  | "fund"           // a fund or ETF symbol (the SEC list has no names to compare)
  | "corrected"      // the read ticker was wrong or unknown; replaced by the one the name matches
  | "found-by-name"  // no ticker was read; found by the company name
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
  // Broker statements: "MICROSOFT CORPORATION CMN", "MASTERCARD INCORPORATED CL A"
  "CMN", "COM", "CL",
]);

// Abbreviations broker statements use where the SEC spells the word out
const NAME_ABBREVIATIONS: Record<string, string> = { INTL: "INTERNATIONAL", TR: "TRUST" };

/** Significant words of a company or asset name: "Walmart Inc. - Common Stock [ST]" → ["WALMART"] */
export function nameTokens(text: string): string[] {
  return text
    .toUpperCase()
    .replace(/\([^)]*\)|\[[^\]]*\]|\/[A-Z]{2}\//g, " ")
    .replace(/[^A-Z0-9]+/g, " ")
    .split(" ")
    .map((w) => NAME_ABBREVIATIONS[w] ?? w)
    .filter((w) => w.length > 1 && !NAME_NOISE.has(w));
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
  const dir: SymbolDirectory = { companies: new Map(), funds: new Set(funds.map(secKey)), byName: new Map() };
  for (const company of companies) {
    const key = secKey(company.ticker);
    if (dir.companies.has(key)) continue;
    dir.companies.set(key, company);
    const name = nameTokens(company.title).join("");
    if (!name) continue;
    // The SEC lists a company's main ticker first (GOOGL before GOOG, BRK-B before BRK-A),
    // so only the first ticker per company is kept for name lookups.
    const same = dir.byName.get(name) ?? [];
    if (!same.some((c) => c.cik === company.cik)) dir.byName.set(name, [...same, company]);
  }
  return dir;
}

/** The one listed company with exactly this name, if there is exactly one. */
export function findByName(dir: SymbolDirectory, asset: string): SecCompany | undefined {
  const matches = dir.byName.get(nameTokens(asset).join(""));
  return matches?.length === 1 ? matches[0] : undefined;
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
