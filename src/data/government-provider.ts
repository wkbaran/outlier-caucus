/**
 * Government Data Provider
 *
 * Fetches congressional trade data directly from government sources:
 *   House: House Clerk annual filing index + PDF decryption per PTR
 *   Senate: Senate eFD individual PTR HTML pages (session-authenticated)
 *
 * Both chambers produce the same FMPTrade shape as the existing pipeline.
 * Includes detailed run-report logging to flag data quality issues.
 */

import { inflateRawSync } from "zlib";
import { createHash } from "crypto";
import { parseHousePtrPdf, expandHouseAssetType, type HousePtrTransaction } from "./house-pdf-parser.js";
import { extractTickerFromDescription } from "./ticker-extract.js";
import type { FMPTrade } from "../types/index.js";
import type { TradeSourceProvider } from "./trade-source.js";
import { loadData, saveData } from "../utils/storage.js";

// ── Constants ─────────────────────────────────────────────────────────────
const HOUSE_INDEX_URL = (year: number) =>
  `https://disclosures-clerk.house.gov/public_disc/financial-pdfs/${year}FD.zip`;
const HOUSE_PTR_URL = (year: number, docId: string) =>
  `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/${year}/${docId}.pdf`;
const SENATE_HOME_URL = "https://efdsearch.senate.gov/search/home/";
const SENATE_SEARCH_URL = "https://efdsearch.senate.gov/search/report/data/";

const HOUSE_SEEN_FILE = "house-seen-docids.json";
const SENATE_SEEN_FILE = "senate-seen-guids.json";
const REVIEW_FILE = "unparseable-filings.json";

// Always re-scan at least this many days of filings. The incremental start
// date comes from the newest stored transaction, so a filing that reaches the
// index late (or a skipped run) could otherwise fall before it and never be
// fetched; seen-ID tracking keeps the overlap cheap.
export const LOOKBACK_DAYS = 30;

const USER_AGENT =
  "outlier-caucus/1.0 (bill.baran@gmail.com) government-data-scraper";

// ── Run report ─────────────────────────────────────────────────────────────
export interface ScrapeRunReport {
  runAt: string;
  house: ChamberReport;
  senate: ChamberReport;
}

interface ChamberReport {
  ptrsProcessed: number;
  ptrsSkipped: number;     // already seen
  ptrsErrored: number;
  tradesExtracted: number;
  flagged: FlaggedItem[];
}

interface FlaggedItem {
  docId: string;
  member?: string;
  issues: string[];
}

/** A filing that yielded no machine-readable transactions and needs a human look */
export interface ReviewFiling {
  chamber: "house" | "senate";
  id: string;
  member: string;
  filingDate: string;
  url: string;
  reason: string;
  firstSeen: string;
}

type ReviewCandidate = Omit<ReviewFiling, "firstSeen">;

// ── Helpers ────────────────────────────────────────────────────────────────

/** The earlier of the incremental start date and LOOKBACK_DAYS before `now` (local midnight) */
export function lookbackSince(sinceDate: Date, now = new Date(), days = LOOKBACK_DAYS): Date {
  const floor = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days);
  return sinceDate < floor ? sinceDate : floor;
}

/** Every House annual index year that can hold filings dated on or after `sinceDate` */
export function houseIndexYears(sinceDate: Date, now = new Date()): number[] {
  const years: number[] = [];
  for (let y = sinceDate.getFullYear(); y <= now.getFullYear(); y++) years.push(y);
  return years;
}

/** Summarize why a filing produced no transactions */
function emptyFilingReason(flags: string[]): string {
  if (flags.some((f) => /image-only|scanned|not encrypted/i.test(f))) return "scanned PDF (image-only)";
  return flags[0] ?? "no transactions parsed";
}

/**
 * Add filings to the persistent review list (deduplicated by chamber + id) and
 * print one clear line for the ones not already on it.
 */
async function recordForReview(chamber: "House" | "Senate", found: ReviewCandidate[]) {
  if (found.length === 0) return;
  const stored = await loadData<ReviewFiling[]>(REVIEW_FILE);
  const list = stored?.data ?? [];
  const known = new Set(list.map((f) => `${f.chamber}:${f.id}`));
  const firstSeen = new Date().toISOString();

  const added: ReviewFiling[] = [];
  for (const f of found) {
    const key = `${f.chamber}:${f.id}`;
    if (known.has(key)) continue;
    known.add(key);
    added.push({ ...f, firstSeen });
  }
  if (added.length === 0) return;

  list.push(...added);
  await saveData(REVIEW_FILE, list);
  log(
    chamber,
    `⚠️  ${added.length} filing(s) need manual review (no machine-readable transactions): ` +
    added.map((f) => `${f.member} ${f.id} — ${f.reason}`).join("; ") +
    ` [${list.length} total in data/${REVIEW_FILE}]`
  );
}

function log(chamber: string, msg: string) {
  const ts = new Date().toTimeString().slice(0, 8); // local time, so it follows TZ
  console.log(`  [${ts}] [${chamber}] ${msg}`);
}

export async function fetchWithUA(url: string, options?: RequestInit) {
  return fetch(url, {
    ...options,
    headers: { "User-Agent": USER_AGENT, ...options?.headers },
  });
}

async function loadSeen(file: string): Promise<Set<string>> {
  const stored = await loadData<string[]>(file);
  return new Set(stored?.data ?? []);
}

async function saveSeen(file: string, seen: Set<string>) {
  await saveData(file, [...seen]);
}

// ── Amount range parser ───────────────────────────────────────────────────
function parseAmountRange(amount: string | undefined): { low: number; high: number } | null {
  if (!amount) return null;
  const m = amount.match(/\$([\d,]+)\s*-\s*\$([\d,]+)/);
  if (m) return {
    low: parseInt(m[1].replace(/,/g, "")),
    high: parseInt(m[2].replace(/,/g, "")),
  };
  const over = amount.match(/Over \$([\d,]+)/i);
  if (over) {
    const v = parseInt(over[1].replace(/,/g, ""));
    return { low: v, high: v * 2 };
  }
  // Some filers report an exact value instead of a range, e.g. "$318.74"
  const exact = amount.match(/^\s*\$([\d,]+(?:\.\d{1,2})?)\s*$/);
  if (exact) {
    const v = parseFloat(exact[1].replace(/,/g, ""));
    return { low: v, high: v };
  }
  return null;
}

function normalizeTransactionType(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const r = raw.toLowerCase();
  if (r.includes("purchase")) return "Purchase";
  // "partial" must be checked before the generic sale match: House PDFs mark a
  // partial sale as "S (partial)" and Senate eFD as "Sale (Partial)".
  if (r.includes("partial")) return "Sale (Partial)";
  if (r.includes("sale") || r === "s") return "Sale (Full)";
  if (r.includes("exchange") || r === "e") return "Exchange";
  return raw;
}

// Generational suffixes that a naive "last token = surname" split mistakes for
// the surname itself (e.g. "Rudy Yakym III" -> lastName "III" instead of "Yakym").
const NAME_SUFFIXES = new Set(["jr", "jr.", "sr", "sr.", "ii", "iii", "iv", "v"]);

/**
 * Split a free-text member name into first/last, stripping a trailing
 * generational suffix so it isn't mistaken for the surname. Only used as a
 * fallback when a source's own pre-split first/last fields aren't available —
 * those are always preferred since they're authoritative and never need this
 * heuristic in the first place.
 */
export function splitMemberName(name: string): { firstName: string; lastName: string } {
  const parts = name.replace(/^Hon\.\s*/i, "").trim().split(/\s+/).filter(Boolean);
  while (parts.length > 2 && NAME_SUFFIXES.has(parts[parts.length - 1].toLowerCase().replace(/\.$/, ""))) {
    parts.pop();
  }
  return { firstName: parts[0] || "", lastName: parts[parts.length - 1] || "" };
}

// ── Convert parsed PTR transaction to FMPTrade shape ─────────────────────
function toFMPTrade(
  tx: HousePtrTransaction,
  firstName: string,
  lastName: string,
  chamber: "senate" | "house",
  ptrLink: string,
  dateReceived?: string
): FMPTrade {
  const amountRange = parseAmountRange(tx.amount);
  const amountStr = tx.amount ?? undefined;

  return {
    firstName,
    lastName,
    office: undefined,
    link: ptrLink,
    dateRecieved: dateReceived,
    transactionDate: tx.transactionDate
      ? reformatDate(tx.transactionDate)
      : undefined,
    owner: tx.owner ?? "self",
    assetDescription: tx.assetDescription,
    assetType: expandHouseAssetType(tx.assetType) ?? "Stock",
    type: normalizeTransactionType(tx.transactionType),
    amount: amountStr,
    comment: tx.comment,
    symbol: tx.ticker,
  };
}

/** Convert MM/DD/YYYY → YYYY-MM-DD */
function reformatDate(d: string): string {
  const m = d.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return d;
  return `${m[3]}-${m[1]}-${m[2]}`;
}

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  HOUSE CLERK                                                             ║
// ╚══════════════════════════════════════════════════════════════════════════╝

async function fetchHouseIndexDocIds(year: number, sinceDate: Date): Promise<
  Array<{ docId: string; firstName: string; lastName: string; filingDate: string; year: number }>
> {
  log("House", `Downloading ${year} filing index ZIP...`);
  const resp = await fetchWithUA(HOUSE_INDEX_URL(year));
  if (!resp.ok) {
    log("House", `  Warning: index ZIP for ${year} returned HTTP ${resp.status}`);
    return [];
  }
  const zipBuf = Buffer.from(await resp.arrayBuffer());
  log("House", `  Index ZIP: ${(zipBuf.length / 1024).toFixed(0)} KB`);

  // Unzip in memory — the ZIP has a simple structure (1-2 files)
  const xmlContent = extractXmlFromZip(zipBuf);
  if (!xmlContent) {
    log("House", "  Could not extract XML from ZIP");
    return [];
  }

  // Parse XML: <Member><Last>..</Last><First>..</First><FilingType>P</FilingType><FilingDate>M/D/YYYY</FilingDate><DocID>N</DocID></Member>
  const members: Array<{
    docId: string; firstName: string; lastName: string; filingDate: string; year: number;
  }> = [];

  const memberRe = /<Member>([\s\S]*?)<\/Member>/g;
  let m: RegExpExecArray | null;
  while ((m = memberRe.exec(xmlContent)) !== null) {
    const block = m[1];
    const getTag = (tag: string) =>
      block.match(new RegExp(`<${tag}>([^<]*)<\/${tag}>`))?.[1]?.trim() ?? "";

    if (getTag("FilingType") !== "P") continue; // Only PTRs

    const filingDate = getTag("FilingDate");
    // Filter by date
    if (filingDate) {
      const d = new Date(filingDate);
      if (!isNaN(d.getTime()) && d < sinceDate) continue;
    }

    members.push({
      docId: getTag("DocID"),
      firstName: getTag("First"),
      lastName: getTag("Last"),
      filingDate,
      year,
    });
  }

  log("House", `  Found ${members.length} PTR filings since ${sinceDate.toISOString().split("T")[0]}`);
  return members;
}

/** Minimal ZIP parser — extracts the XML from the House Clerk annual ZIP */
function extractXmlFromZip(zipBuf: Buffer): string | null {
  // Find local file headers (signature 0x04034b50)
  let pos = 0;
  while (pos < zipBuf.length - 30) {
    const sig = zipBuf.readUInt32LE(pos);
    if (sig !== 0x04034b50) { pos++; continue; }

    const compression = zipBuf.readUInt16LE(pos + 8);
    const compSize = zipBuf.readUInt32LE(pos + 18);
    const nameLen = zipBuf.readUInt16LE(pos + 26);
    const extraLen = zipBuf.readUInt16LE(pos + 28);
    const name = zipBuf.slice(pos + 30, pos + 30 + nameLen).toString("utf8");
    const dataStart = pos + 30 + nameLen + extraLen;

    if (name.endsWith(".xml")) {
      const compData = zipBuf.slice(dataStart, dataStart + compSize);
      if (compression === 0) {
        return compData.toString("utf8"); // Stored (no compression)
      } else if (compression === 8) {
        return inflateRawSync(compData).toString("utf8"); // DEFLATE
      }
    }
    pos = dataStart + compSize;
  }
  return null;
}

/**
 * Returns the filing's trades, or null when the PDF couldn't be downloaded —
 * a transient failure the caller should retry next run rather than mark seen.
 * Filings that download but yield no transactions go on `review`.
 */
async function processHousePtr(
  entry: { docId: string; firstName: string; lastName: string; filingDate: string; year: number },
  chamberReport: ChamberReport,
  review: ReviewCandidate[]
): Promise<FMPTrade[] | null> {
  const ptrUrl = HOUSE_PTR_URL(entry.year, entry.docId);
  log("House", `Processing PTR ${entry.docId}: ${entry.lastName}, ${entry.firstName}`);

  let pdfBytes: Buffer;
  try {
    const resp = await fetchWithUA(ptrUrl);
    if (!resp.ok) {
      log("House", `  ⚠️  HTTP ${resp.status} — will retry next run`);
      chamberReport.ptrsErrored++;
      chamberReport.flagged.push({
        docId: entry.docId,
        member: `${entry.firstName} ${entry.lastName}`,
        issues: [`HTTP ${resp.status} fetching PDF`],
      });
      return null;
    }
    pdfBytes = Buffer.from(await resp.arrayBuffer());
  } catch (e) {
    log("House", `  ⚠️  Fetch error: ${(e as Error).message} — will retry next run`);
    chamberReport.ptrsErrored++;
    return null;
  }

  let parsed;
  try {
    parsed = await parseHousePtrPdf(pdfBytes);
  } catch (e) {
    log("House", `  ⚠️  Parse error: ${(e as Error).message}`);
    chamberReport.ptrsErrored++;
    chamberReport.flagged.push({
      docId: entry.docId,
      member: `${entry.firstName} ${entry.lastName}`,
      issues: [`Parse error: ${(e as Error).message}`],
    });
    review.push({
      chamber: "house", id: entry.docId, member: `${entry.firstName} ${entry.lastName}`,
      filingDate: entry.filingDate, url: ptrUrl, reason: `parse error: ${(e as Error).message}`,
    });
    return [];
  }

  // The House Clerk's own index already provides cleanly split first/last
  // fields (with generational suffixes like "III" kept separate) — trust
  // those over re-splitting the PDF's own free-text header, which is only
  // used as a fallback for the rare case the index entry lacks a name.
  const { firstName, lastName } = entry.firstName && entry.lastName
    ? { firstName: entry.firstName, lastName: entry.lastName }
    : splitMemberName(parsed.memberName ?? `${entry.firstName} ${entry.lastName}`);

  const trades = parsed.transactions.map(tx =>
    toFMPTrade(tx, firstName, lastName, "house", ptrUrl, entry.filingDate)
  );

  chamberReport.ptrsProcessed++;
  chamberReport.tradesExtracted += trades.length;

  const txSummary = trades
    .map(t => `${t.symbol || "???"} ${t.type || "?"} ${t.amount || "?"}`)
    .join(", ");
  log("House", `  ✅ ${trades.length} trade(s): ${txSummary.slice(0, 80)}`);

  if (parsed.flags.length > 0) {
    log("House", `  ⚠️  Flags: ${parsed.flags.join("; ")}`);
    chamberReport.flagged.push({
      docId: entry.docId,
      member: `${firstName} ${lastName}`,
      issues: parsed.flags,
    });
  }

  if (trades.length === 0) {
    review.push({
      chamber: "house", id: entry.docId, member: `${firstName} ${lastName}`,
      filingDate: entry.filingDate, url: ptrUrl, reason: emptyFilingReason(parsed.flags),
    });
  }

  return trades;
}

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  SENATE EFD                                                              ║
// ╚══════════════════════════════════════════════════════════════════════════╝

/** Collect name=value pairs from a response's Set-Cookie headers */
function readSetCookies(resp: Response, jar: Map<string, string>) {
  for (const c of resp.headers.getSetCookie()) {
    const m = c.match(/^\s*([^=;\s]+)=([^;]*)/);
    if (m) jar.set(m[1], m[2]);
  }
}

/** Accept terms and return a session cookie string */
export async function acceptSenatEfdTerms(): Promise<string | null> {
  // Get CSRF token from home page
  const homeResp = await fetchWithUA(SENATE_HOME_URL);
  if (!homeResp.ok) return null;
  const homeHtml = await homeResp.text();

  const jar = new Map<string, string>();
  readSetCookies(homeResp, jar);
  const csrf = homeHtml.match(/csrfmiddlewaretoken[^>]*value="([^"]+)"/)?.[1];
  if (!csrf || !jar.has("csrftoken")) return null;

  // POST acceptance
  const acceptResp = await fetchWithUA(SENATE_HOME_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Referer": SENATE_HOME_URL,
      "Cookie": `csrftoken=${jar.get("csrftoken")}`,
    },
    body: `prohibition_agreement=1&csrfmiddlewaretoken=${encodeURIComponent(csrf)}`,
    redirect: "manual",
  });

  // The acceptance response may rotate csrftoken and sets sessionid; later
  // values win over the home-page ones.
  readSetCookies(acceptResp, jar);
  const parts = ["csrftoken", "sessionid"]
    .filter((k) => jar.has(k))
    .map((k) => `${k}=${jar.get(k)}`);
  return parts.join("; ");
}

/** Format a date as the eFD search form expects: "MM/DD/YYYY 00:00:00" */
function formatEfdDate(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}/${dd}/${d.getFullYear()} 00:00:00`;
}

async function fetchSenatePtrGuids(
  cookie: string,
  sinceDate: Date,
  paperFilings: ReviewCandidate[] = []
): Promise<Array<{ guid: string; firstName: string; lastName: string; filedDate: string }>> {
  // The AJAX search API is a DataTables endpoint: POST form data with
  // start/length paging, filtered server-side by submission date. (GET
  // requests return 503.) Rows come back newest-first as arrays of
  // [first, last, office, linkHtml, filedDate].
  const pageSize = 100;
  const maxPages = 50; // 5,000 filings — far beyond any realistic window
  const csrf = cookie.match(/csrftoken=([^;]+)/)?.[1] ?? "";
  const results: Array<{ guid: string; firstName: string; lastName: string; filedDate: string }> = [];
  let paperSkipped = 0;

  for (let page = 0; page < maxPages; page++) {
    const start = page * pageSize;
    const body = new URLSearchParams({
      start: String(start),
      length: String(pageSize),
      report_types: "[11]",
      filer_types: "[]",
      submitted_start_date: formatEfdDate(sinceDate),
      submitted_end_date: "",
      candidate_state: "",
      senator_state: "",
      office_id: "",
      first_name: "",
      last_name: "",
      csrfmiddlewaretoken: csrf,
    });

    const resp = await fetchWithUA(SENATE_SEARCH_URL, {
      method: "POST",
      headers: {
        "X-Requested-With": "XMLHttpRequest",
        "Accept": "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "Referer": "https://efdsearch.senate.gov/search/",
        "X-CSRFToken": csrf,
        "Cookie": cookie,
      },
      body,
    });

    if (!resp.ok) {
      log("Senate", `  ⚠️  Search API returned HTTP ${resp.status} — Senate filings NOT fetched this run`);
      break;
    }

    let json: unknown;
    try {
      json = await resp.json();
    } catch {
      log("Senate", "  ⚠️  Search API returned non-JSON — Senate filings NOT fetched this run");
      break;
    }

    const { data = [], recordsFiltered } = json as { data?: unknown[]; recordsFiltered?: number };
    if (data.length === 0) break;

    let hasOld = false;
    for (const row of data) {
      let firstName: string, lastName: string, link: string, filedDate: string;
      if (Array.isArray(row)) {
        [firstName = "", lastName = "", , link = "", filedDate = ""] = row as string[];
      } else {
        const r = row as { first_name?: string; last_name?: string; filed_date?: string; link?: string[] };
        firstName = r.first_name || "";
        lastName = r.last_name || "";
        link = r.link?.[0] || r.link?.[1] || "";
        filedDate = r.filed_date || "";
      }

      // Paper filings are scanned images with no parseable transaction table
      const paperM = link.match(/\/paper\/([a-f0-9-]+)\//);
      if (paperM) {
        paperSkipped++;
        paperFilings.push({
          chamber: "senate", id: paperM[1], member: `${firstName} ${lastName}`.replace(/\s+/g, " ").trim(),
          filingDate: filedDate, url: `https://efdsearch.senate.gov/search/view/paper/${paperM[1]}/`,
          reason: "paper filing (scanned)",
        });
        continue;
      }
      const guidM = link.match(/\/ptr\/([a-f0-9-]+)\//);
      if (!guidM) continue;

      if (filedDate) {
        const d = new Date(filedDate);
        if (!isNaN(d.getTime()) && d < sinceDate) { hasOld = true; continue; }
      }

      results.push({ guid: guidM[1], firstName, lastName, filedDate });
    }

    const total = recordsFiltered ?? Infinity;
    if (data.length < pageSize || start + data.length >= total || hasOld) break;
  }

  if (paperSkipped > 0) {
    log("Senate", `  Skipped ${paperSkipped} paper (scanned) filing(s) — not machine-readable`);
  }
  return results;
}

export function parseSenatePtrPage(html: string): {
  memberName?: string;
  filingDate?: string;
  transactions: Array<{
    transactionDate: string;
    owner: string;
    ticker: string;
    assetDescription: string;
    assetType: string;
    transactionType: string;
    amount: string;
    comment: string;
  }>;
  flags: string[];
} {
  const flags: string[] = [];

  // Extract member name from title
  // The name is split across lines in the markup ("The Honorable John\n  Boozman")
  const memberM = html.match(/The Honorable\s+([^<(]+)/);
  const memberName = memberM ? memberM[1].replace(/\s+/g, " ").trim() : undefined;

  const filingM = html.match(/Filed\s+(\d{2}\/\d{2}\/\d{4})/);
  const filingDate = filingM ? filingM[1] : undefined;

  // Strip tags for text parsing
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#35;/g, "#")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ");

  // Parse transaction table
  // Pattern: # | date | owner | ticker | asset | type | txn_type | amount | comment
  const transactions: ReturnType<typeof parseSenatePtrPage>["transactions"] = [];

  // Find the transactions list block
  const txListStart = text.indexOf("List of transactions added to this report");
  if (txListStart < 0) {
    flags.push("No transaction list found in PTR page");
    return { memberName, filingDate, transactions, flags };
  }

  const txSection = text.slice(txListStart);

  // Each row: number, date, owner, ticker, asset, type, txntype, amount, comment
  // The numbers are sequential: 1, 2, 3...
  // Dates match MM/DD/YYYY
  // Read the table cell-by-cell, keyed by its header row. Matching the flattened
  // text with a regex broke on owners ("Child") and asset types ("Non-Public
  // Stock", "Corporate Bond") it didn't enumerate.
  const decodeCell = (cell: string) => cell
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&#35;/g, "#")
    .replace(/\s+/g, " ")
    .trim();

  for (const table of html.match(/<table[\s\S]*?<\/table>/gi) ?? []) {
    const rows = (table.match(/<tr[\s\S]*?<\/tr>/gi) ?? [])
      .map((tr) => (tr.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) ?? []).map(decodeCell));
    const header = rows[0]?.map((h) => h.toLowerCase()) ?? [];
    const col = (name: string) => header.indexOf(name);
    const iDate = col("transaction date");
    if (iDate < 0) continue;
    const [iOwner, iTicker, iAsset, iAssetType, iType, iAmount, iComment] =
      ["owner", "ticker", "asset name", "asset type", "type", "amount", "comment"].map(col);

    for (const cells of rows.slice(1)) {
      const date = cells[iDate] ?? "";
      if (!/^\d{2}\/\d{2}\/\d{4}$/.test(date)) continue;
      const ticker = cells[iTicker] ?? "";
      transactions.push({
        transactionDate: date,
        owner: cells[iOwner] ?? "",
        ticker: ticker === "--" ? "" : ticker,
        assetDescription: cells[iAsset] ?? "",
        assetType: cells[iAssetType] ?? "",
        transactionType: cells[iType] ?? "",
        amount: cells[iAmount] ?? "",
        comment: cells[iComment] ?? "",
      });
    }
  }

  if (transactions.length === 0) {
    flags.push("No transactions found in PTR page — review manually");
  }

  return { memberName, filingDate, transactions, flags };
}

/** Same contract as processHousePtr: null means retry next run */
async function processSenatePtr(
  entry: { guid: string; firstName: string; lastName: string; filedDate: string },
  cookie: string,
  chamberReport: ChamberReport,
  review: ReviewCandidate[]
): Promise<FMPTrade[] | null> {
  const ptrUrl = `https://efdsearch.senate.gov/search/view/ptr/${entry.guid}/`;
  log("Senate", `Processing PTR ${entry.guid}: ${entry.lastName}, ${entry.firstName}`);

  let html: string;
  try {
    const resp = await fetchWithUA(ptrUrl, {
      headers: { Cookie: cookie, Referer: "https://efdsearch.senate.gov/search/" },
    });
    if (!resp.ok) {
      log("Senate", `  ⚠️  HTTP ${resp.status} — will retry next run`);
      chamberReport.ptrsErrored++;
      return null;
    }
    html = await resp.text();
  } catch (e) {
    log("Senate", `  ⚠️  Fetch error: ${(e as Error).message} — will retry next run`);
    chamberReport.ptrsErrored++;
    return null;
  }

  const parsed = parseSenatePtrPage(html);
  // The search API's own first_name/last_name fields are authoritative and
  // don't need re-splitting; only fall back to the PDF's free-text header
  // (with suffix-aware splitting) if the search result lacked a name.
  const { firstName, lastName } = entry.firstName && entry.lastName
    ? { firstName: entry.firstName, lastName: entry.lastName }
    : splitMemberName(parsed.memberName ?? `${entry.firstName} ${entry.lastName}`);

  const trades: FMPTrade[] = parsed.transactions.map(tx => {
    return {
      firstName,
      lastName,
      office: undefined,
      link: ptrUrl,
      dateRecieved: parsed.filingDate,
      transactionDate: reformatDate(tx.transactionDate),
      owner: tx.owner,
      assetDescription: tx.assetDescription,
      assetType: tx.assetType,
      type: tx.transactionType,
      amount: tx.amount,
      comment: tx.comment === "--" ? undefined : tx.comment,
      // Senate rows often leave the ticker column "--" but name it in the asset
      // description, e.g. "SDZNY- Sandoz Group AG ADR"
      symbol: tx.ticker || extractTickerFromDescription(tx.assetDescription),
    };
  });

  chamberReport.ptrsProcessed++;
  chamberReport.tradesExtracted += trades.length;

  const txSummary = trades
    .map(t => `${t.symbol || "???"} ${t.type || "?"} ${t.amount || "?"}`)
    .join(", ");
  log("Senate", `  ✅ ${trades.length} trade(s): ${txSummary.slice(0, 80)}`);

  if (parsed.flags.length > 0) {
    log("Senate", `  ⚠️  Flags: ${parsed.flags.join("; ")}`);
    chamberReport.flagged.push({ docId: entry.guid, member: `${firstName} ${lastName}`, issues: parsed.flags });
  }

  if (trades.length === 0) {
    review.push({
      chamber: "senate", id: entry.guid, member: `${firstName} ${lastName}`,
      filingDate: parsed.filingDate ?? entry.filedDate, url: ptrUrl, reason: emptyFilingReason(parsed.flags),
    });
  }

  return trades;
}

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  GovernmentProvider — TradeSourceProvider implementation                 ║
// ╚══════════════════════════════════════════════════════════════════════════╝

export class GovernmentProvider implements TradeSourceProvider {
  private lastRunReport: ScrapeRunReport | null = null;

  getName(): string { return "Government (House Clerk + Senate eFD)"; }

  async fetchSenateTrades(sinceDate: Date): Promise<FMPTrade[]> {
    const chamberReport: ChamberReport = {
      ptrsProcessed: 0, ptrsSkipped: 0, ptrsErrored: 0, tradesExtracted: 0, flagged: [],
    };

    const effectiveSince = lookbackSince(sinceDate);
    log("Senate", `Fetching filings since ${effectiveSince.toISOString().split("T")[0]}` +
      (effectiveSince < sinceDate ? ` (${LOOKBACK_DAYS}-day lookback)` : ""));

    // Accept terms
    const cookie = await acceptSenatEfdTerms();
    if (!cookie) {
      log("Senate", "⚠️  Could not accept eFD terms — skipping Senate fetch");
      return [];
    }
    log("Senate", "Session established");

    // Get known GUIDs
    const seen = await loadSeen(SENATE_SEEN_FILE);
    log("Senate", `${seen.size} PTRs already seen`);

    // Fetch new PTR GUIDs from search
    const review: ReviewCandidate[] = [];
    const entries = await fetchSenatePtrGuids(cookie, effectiveSince, review);
    log("Senate", `${entries.length} PTR(s) from search (${entries.filter(e => seen.has(e.guid)).length} already seen)`);

    const trades: FMPTrade[] = [];
    let delay = 1000;

    for (const entry of entries) {
      if (seen.has(entry.guid)) { chamberReport.ptrsSkipped++; continue; }

      await new Promise(r => setTimeout(r, delay));
      const entryTrades = await processSenatePtr(entry, cookie, chamberReport, review);
      if (entryTrades === null) continue; // transient failure — retry next run
      trades.push(...entryTrades);
      seen.add(entry.guid);
    }

    await saveSeen(SENATE_SEEN_FILE, seen);
    await recordForReview("Senate", review);
    this.lastRunReport = { ...this.lastRunReport!, senate: chamberReport } as ScrapeRunReport;

    log("Senate", `Done: ${chamberReport.ptrsProcessed} processed, ${chamberReport.tradesExtracted} trades, ${chamberReport.flagged.length} flagged`);
    return trades;
  }

  async fetchHouseTrades(sinceDate: Date): Promise<FMPTrade[]> {
    const chamberReport: ChamberReport = {
      ptrsProcessed: 0, ptrsSkipped: 0, ptrsErrored: 0, tradesExtracted: 0, flagged: [],
    };
    this.lastRunReport = {
      runAt: new Date().toISOString(),
      house: chamberReport,
      senate: { ptrsProcessed: 0, ptrsSkipped: 0, ptrsErrored: 0, tradesExtracted: 0, flagged: [] },
    };

    const effectiveSince = lookbackSince(sinceDate);
    log("House", `Fetching filings since ${effectiveSince.toISOString().split("T")[0]}` +
      (effectiveSince < sinceDate ? ` (${LOOKBACK_DAYS}-day lookback)` : ""));

    const seen = await loadSeen(HOUSE_SEEN_FILE);
    log("House", `${seen.size} PTRs already seen`);

    // One index ZIP per year; a lookback in early January reaches into last year's
    const allEntries: Array<{
      docId: string; firstName: string; lastName: string; filingDate: string; year: number;
    }> = [];

    for (const year of houseIndexYears(effectiveSince)) {
      const entries = await fetchHouseIndexDocIds(year, effectiveSince);
      allEntries.push(...entries);
    }

    const newEntries = allEntries.filter(e => !seen.has(e.docId));
    log("House", `${allEntries.length} PTRs in date range, ${newEntries.length} new`);

    if (newEntries.length === 0) {
      log("House", "Nothing new to process");
      return [];
    }

    const trades: FMPTrade[] = [];
    const review: ReviewCandidate[] = [];
    let i = 0;

    for (const entry of newEntries) {
      i++;
      process.stdout.write(
        `\r  [House] Processing ${i}/${newEntries.length}: ${entry.lastName}, ${entry.firstName}                `
      );

      await new Promise(r => setTimeout(r, 800)); // 800ms between PDF fetches
      const entryTrades = await processHousePtr(entry, chamberReport, review);
      if (entryTrades === null) continue; // transient failure — retry next run
      trades.push(...entryTrades);
      seen.add(entry.docId);
    }
    process.stdout.write("\n");

    await saveSeen(HOUSE_SEEN_FILE, seen);
    await recordForReview("House", review);
    this.lastRunReport!.house = chamberReport;

    log("House", `Done: ${chamberReport.ptrsProcessed} processed, ${chamberReport.tradesExtracted} trades, ${chamberReport.flagged.length} flagged, ${chamberReport.ptrsErrored} errors`);

    return trades;
  }

  /** Save and print the run report */
  async saveRunReport(dataDir = "data"): Promise<string> {
    if (!this.lastRunReport) return "";
    const report = this.lastRunReport;
    const filename = `scrape-report-${report.runAt.slice(0, 10)}.json`;
    await saveData(filename, report, "reports");

    console.log("\n" + "═".repeat(60));
    console.log("GOVERNMENT SCRAPE RUN REPORT");
    console.log("═".repeat(60));

    for (const chamber of ["house", "senate"] as const) {
      const r = report[chamber];
      console.log(`\n${chamber.toUpperCase()}:`);
      console.log(`  PTRs processed: ${r.ptrsProcessed}`);
      console.log(`  PTRs skipped (seen): ${r.ptrsSkipped}`);
      console.log(`  PTRs errored: ${r.ptrsErrored}`);
      console.log(`  Trades extracted: ${r.tradesExtracted}`);
      if (r.flagged.length > 0) {
        console.log(`  Flagged for review (${r.flagged.length}):`);
        for (const f of r.flagged) {
          console.log(`    • ${f.member ?? f.docId}: ${f.issues.join("; ")}`);
        }
      } else {
        console.log("  No items flagged.");
      }
    }

    console.log("\n" + "═".repeat(60));
    console.log(`Full report: data/reports/${filename}`);

    return filename;
  }
}

export function createGovernmentProvider(): GovernmentProvider {
  return new GovernmentProvider();
}
