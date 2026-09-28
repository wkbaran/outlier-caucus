/**
 * Stock Watcher Trade Source Provider
 *
 * Fetches congressional trade disclosures from the community-maintained
 * house-stock-watcher and senate-stock-watcher open datasets, which mirror
 * the public-domain PTR filings from the House Clerk and Senate eFD.
 */

import type { FMPTrade } from "../types/index.js";
import type { TradeSourceProvider } from "./trade-source.js";

// Senate data is maintained in GitHub (community-maintained mirror of Senate eFD PTR filings)
const SENATE_URL =
  "https://raw.githubusercontent.com/timothycarambat/senate-stock-watcher-data/master/aggregate/all_transactions.json";

// House data: try the original S3 bucket first; the site has been intermittently unavailable.
// If S3 returns 403, throw HouseDataUnavailableError so the caller can fall back to FMP.
const HOUSE_S3_URL =
  "https://house-stock-watcher-data.s3-us-west-2.amazonaws.com/data/all_transactions.json";

export class HouseDataUnavailableError extends Error {
  constructor() {
    super(
      "House stock-watcher S3 data is unavailable (HTTP 403).\n" +
      "Set DATA_SOURCE=fmp in .env to use FMP for House trade data,\n" +
      "or wait for the community mirror to come back online."
    );
    this.name = "HouseDataUnavailableError";
  }
}

const USER_AGENT = "outlier-caucus/1.0 (bill.baran@gmail.com)";

// ── Senate schema ──────────────────────────────────────────────────────────

interface SenateTransaction {
  transaction_date?: string;
  owner?: string;
  ticker?: string;
  asset_description?: string;
  asset_type?: string;
  type?: string;
  amount?: string;
  comment?: string;
}

interface SenateRecord {
  first_name?: string;
  last_name?: string;
  office?: string;
  ptr_link?: string;
  date_recieved?: string; // their typo — matches ours
  transactions?: SenateTransaction[];
}

// ── House schema ───────────────────────────────────────────────────────────

interface HouseTransaction {
  transaction_date?: string;
  owner?: string;
  ticker?: string;
  asset_description?: string;
  asset_type?: string;
  type?: string;
  amount?: string;
  comment?: string;
  // Some versions nest these on the parent; some versions flatten them here
  representative?: string;
  first_name?: string;
  last_name?: string;
  office?: string;
  ptr_link?: string;
  date_received?: string;
  date_recieved?: string; // alternate spelling in some dumps
}

// ── Helpers ────────────────────────────────────────────────────────────────

function parseDate(raw: string | undefined): Date | null {
  if (!raw) return null;
  // Accept MM/DD/YYYY and YYYY-MM-DD
  const d = new Date(raw);
  if (!isNaN(d.getTime())) return d;
  return null;
}

function isOnOrAfter(raw: string | undefined, since: Date): boolean {
  const d = parseDate(raw);
  if (!d) return true; // include if date unknown
  return d >= since;
}

async function fetchJson<T>(url: string, allowedFailureCodes?: number[]): Promise<{ data: T; status: number }> {
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!response.ok) {
    if (allowedFailureCodes?.includes(response.status)) {
      return { data: null as unknown as T, status: response.status };
    }
    throw new Error(`StockWatcher fetch failed: ${response.status} ${response.statusText} (${url})`);
  }
  return { data: await response.json() as T, status: response.status };
}

// ── Provider ───────────────────────────────────────────────────────────────

export class StockWatcherProvider implements TradeSourceProvider {
  getName(): string {
    return "StockWatcher (house-stock-watcher + senate-stock-watcher)";
  }

  async fetchSenateTrades(sinceDate: Date): Promise<FMPTrade[]> {
    console.log(`  [StockWatcher] Fetching Senate trades since ${sinceDate.toISOString().split("T")[0]}...`);
    const { data: records } = await fetchJson<SenateRecord[]>(SENATE_URL);

    const trades: FMPTrade[] = [];

    for (const record of records) {
      if (!record.transactions?.length) continue;

      for (const tx of record.transactions) {
        if (!isOnOrAfter(tx.transaction_date, sinceDate)) continue;

        trades.push({
          firstName: record.first_name,
          lastName: record.last_name,
          office: record.office,
          link: record.ptr_link,
          dateRecieved: record.date_recieved,
          transactionDate: normalizeDate(tx.transaction_date),
          owner: tx.owner,
          assetDescription: tx.asset_description,
          assetType: tx.asset_type,
          type: tx.type,
          amount: tx.amount,
          comment: tx.comment,
          symbol: normalizeTicker(tx.ticker),
        });
      }
    }

    console.log(`  [StockWatcher] Senate: ${trades.length} trades`);
    return trades;
  }

  async fetchHouseTrades(sinceDate: Date): Promise<FMPTrade[]> {
    console.log(`  [StockWatcher] Fetching House trades since ${sinceDate.toISOString().split("T")[0]}...`);
    const { data: records, status } = await fetchJson<HouseTransaction[]>(HOUSE_S3_URL, [403]);
    if (status === 403 || !records) {
      throw new HouseDataUnavailableError();
    }

    const trades: FMPTrade[] = [];

    for (const tx of records) {
      if (!isOnOrAfter(tx.transaction_date, sinceDate)) continue;

      // Name may be in `representative` or `first_name`/`last_name`
      let firstName = tx.first_name;
      let lastName = tx.last_name;
      if (!firstName && !lastName && tx.representative) {
        const parts = tx.representative.trim().split(/\s+/);
        firstName = parts[0];
        lastName = parts.slice(1).join(" ");
      }

      trades.push({
        firstName,
        lastName,
        office: tx.office,
        link: tx.ptr_link,
        dateRecieved: tx.date_received ?? tx.date_recieved,
        transactionDate: normalizeDate(tx.transaction_date),
        owner: tx.owner,
        assetDescription: tx.asset_description,
        assetType: tx.asset_type,
        type: tx.type,
        amount: tx.amount,
        comment: tx.comment,
        symbol: normalizeTicker(tx.ticker),
      });
    }

    console.log(`  [StockWatcher] House: ${trades.length} trades`);
    return trades;
  }
}

/** Normalize MM/DD/YYYY → YYYY-MM-DD; pass through YYYY-MM-DD unchanged */
function normalizeDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  // Already ISO-ish
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  // MM/DD/YYYY
  const m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return raw;
}

/** Return undefined for placeholder tickers like "--" or "" */
function normalizeTicker(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const t = raw.trim();
  if (t === "--" || t === "" || t === "N/A") return undefined;
  return t;
}
