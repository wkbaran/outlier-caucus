/**
 * OCR the scanned filings on the review list (House image-only PTR PDFs and Senate
 * paper filings), record per-page outcomes with an audit trail, and merge validated
 * rows into the trade data. Shared by the daily run and the ocr:catchup command.
 */
import * as fs from "fs/promises";
import * as path from "path";
import type { FMPTrade } from "../types/index.js";
import { loadData, saveData } from "../utils/storage.js";
import { acceptSenatEfdTerms, fetchWithUA, splitMemberName, type ReviewFiling } from "../data/government-provider.js";
import { pagesFromDocument, rotationCandidates, type PageSource, type RenderedPage, type Rotation } from "./render.js";
import {
  checkOllama, normalizeDate, ocrOptionsFromEnv, ocrPage, pageQuality, validateRows, MIN_PAGE_QUALITY,
  type FormKind, type OcrOptions, type PageOcr, type ValidRow, type Validation,
} from "./ocr-page.js";

const REVIEW_FILE = "unparseable-filings.json";
const OCR_RESULTS_FILE = "ocr-results.json";
const TRADES_FILE = "trades.json";
export const OCR_ARTIFACT_DIR = path.join("logs", "ocr");

export type Log = (line: string) => void;

interface StoredTrades {
  senateTrades: FMPTrade[];
  houseTrades: FMPTrade[];
}

export type PageStatus = "ok" | "empty" | "needs-review" | "error";
export type FilingStatus = "done" | "needs-review" | "failed";

export interface OcrPageRecord {
  page: number;
  rotation: Rotation;
  attempts: number;
  seconds: number;
  status: PageStatus;
  quality: number;
  validRows: number;
  rejectedRows: number;
  skippedRows: number;
  error?: string;
}

export interface OcrFilingRecord {
  chamber: "house" | "senate";
  id: string;
  member: string;
  url: string;
  filingDate: string;
  model: string;
  status: FilingStatus;
  pageCount: number;
  pages: OcrPageRecord[];
  trades: number;
  merged: boolean;
  artifactDir: string;
  error?: string;
  startedAt: string;
  finishedAt: string;
}

export interface FilingOcrOutcome {
  record: OcrFilingRecord;
  trades: FMPTrade[];
}

export const filingKey = (f: { chamber: string; id: string }) => `${f.chamber}:${f.id}`;

/**
 * Chambers whose scanned filings are OCR'd (OCR_CHAMBERS, default both). OCR is the last
 * resort for any filing without machine-readable transactions: an imperfect row marked
 * OCR in the report is easier to notice and fix than a trade that's silently missing.
 */
export function enabledOcrChambers(env: NodeJS.ProcessEnv = process.env): Array<"house" | "senate"> {
  return (env.OCR_CHAMBERS ?? "house,senate")
    .split(",")
    .map((c) => c.trim().toLowerCase())
    .filter((c): c is "house" | "senate" => c === "house" || c === "senate");
}

/** Review-list filings that are scans (image-only House PDFs, Senate paper filings) in the given chambers */
export async function loadScannedFilings(chambers = enabledOcrChambers()): Promise<ReviewFiling[]> {
  const stored = await loadData<ReviewFiling[]>(REVIEW_FILE);
  return (stored?.data ?? []).filter((f) => /scanned|paper/i.test(f.reason) && chambers.includes(f.chamber));
}

export async function loadOcrResults(): Promise<Record<string, OcrFilingRecord>> {
  return (await loadData<Record<string, OcrFilingRecord>>(OCR_RESULTS_FILE))?.data ?? {};
}

async function saveOcrRecord(record: OcrFilingRecord) {
  const results = await loadOcrResults();
  results[filingKey(record)] = record;
  await saveData(OCR_RESULTS_FILE, results);
}

function mimeFromUrl(url: string): string {
  const ext = url.split("?")[0].split(".").pop()?.toLowerCase();
  if (ext === "gif") return "image/gif";
  if (ext === "png") return "image/png";
  return "image/jpeg";
}

/** Download a filing and expose its pages for rendering. */
export async function loadFilingPages(filing: ReviewFiling): Promise<PageSource[]> {
  if (filing.chamber === "house") {
    const resp = await fetchWithUA(filing.url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} downloading ${filing.url}`);
    return pagesFromDocument(new Uint8Array(await resp.arrayBuffer()), "application/pdf");
  }

  // A Senate paper filing is an HTML page listing one scanned GIF per page
  const cookie = await acceptSenatEfdTerms();
  if (!cookie) throw new Error("could not accept the Senate eFD terms");
  const pageResp = await fetchWithUA(filing.url, {
    headers: { Cookie: cookie, Referer: "https://efdsearch.senate.gov/search/" },
  });
  if (!pageResp.ok) throw new Error(`HTTP ${pageResp.status} loading ${filing.url}`);
  const html = await pageResp.text();
  const imageUrls = [
    ...new Set(
      [...html.matchAll(/<img[^>]+src="(https:\/\/efd-media-public\.senate\.gov\/[^"]+\.(?:gif|png|jpe?g))"/gi)].map((m) => m[1])
    ),
  ];
  if (imageUrls.length === 0) throw new Error("no page images found on the paper filing page");

  const pages: PageSource[] = [];
  for (const url of imageUrls) {
    const resp = await fetchWithUA(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} downloading ${url}`);
    pages.push(...pagesFromDocument(new Uint8Array(await resp.arrayBuffer()), mimeFromUrl(url)));
  }
  return pages;
}

interface PageAttempt {
  rotation: Rotation;
  image: RenderedPage;
  ocr: PageOcr;
  validation: Validation;
  quality: number;
}

/** OCR a page at its most likely orientation, falling back to the alternative when the result reads badly. */
/**
 * Earliest believable transaction date for a filing: PTRs are due within 45 days and late
 * filings run months, not years, so anything over 3 years before filing is a misread
 * (often the date printed on the form's example row).
 */
export function earliestPlausibleDate(filingDate: string): string | undefined {
  const iso = normalizeDate(filingDate);
  return iso ? `${Number(iso.slice(0, 4)) - 3}${iso.slice(4)}` : undefined;
}

async function ocrPageWithRotations(page: PageSource, form: FormKind, ocr: OcrOptions, earliest?: string) {
  let best: PageAttempt | undefined;
  let attempts = 0;
  let seconds = 0;

  for (const rotation of rotationCandidates(page.portrait, form === "house")) {
    const image = page.render(rotation);
    const result = await ocrPage(image.png, form, ocr);
    attempts++;
    seconds += result.seconds;

    const validation = validateRows(result.rows, undefined, earliest);
    const quality = result.error ? 0 : pageQuality(validation, result.readable);
    if (!best || quality > best.quality) best = { rotation, image, ocr: result, validation, quality };

    if (!result.error && result.readable && quality >= MIN_PAGE_QUALITY) break;
    // Ollama being down or timing out won't improve by rotating the page
    if (result.error && result.error !== "model response was not valid JSON") break;
  }

  return { ...best!, attempts, seconds: Math.round(seconds * 10) / 10 };
}

function toTrade(row: ValidRow, filing: ReviewFiling, page: number): FMPTrade {
  const { firstName, lastName } = splitMemberName(filing.member);
  return {
    firstName,
    lastName,
    office: undefined,
    link: filing.url,
    dateRecieved: filing.filingDate || undefined,
    transactionDate: row.transactionDate,
    owner: row.owner ?? "self",
    assetDescription: row.asset,
    type: row.type,
    amount: row.amount,
    comment: `OCR page ${page}`,
    symbol: row.ticker,
    source: "ocr",
  };
}

/**
 * OCR every page of one filing. Every page's raw model output and validation go to
 * `logs/ocr/<chamber>-<id>/page-N.json`; pages needing a human look also get their
 * rendered image. Every row that validates becomes a trade, including rows on pages
 * flagged for review, so a hard-to-read page yields its readable rows instead of none.
 */
export async function ocrFiling(
  filing: ReviewFiling,
  opts: { ocr: OcrOptions; log: Log; pages?: PageSource[] }
): Promise<FilingOcrOutcome> {
  const { ocr, log } = opts;
  const artifactDir = path.join(OCR_ARTIFACT_DIR, `${filing.chamber}-${filing.id}`);
  const startedAt = new Date().toISOString();
  const record: OcrFilingRecord = {
    chamber: filing.chamber,
    id: filing.id,
    member: filing.member,
    url: filing.url,
    filingDate: filing.filingDate,
    model: ocr.model,
    status: "failed",
    pageCount: 0,
    pages: [],
    trades: 0,
    merged: false,
    artifactDir,
    startedAt,
    finishedAt: startedAt,
  };

  let pages: PageSource[];
  try {
    pages = opts.pages ?? (await loadFilingPages(filing));
  } catch (err) {
    record.error = (err as Error).message;
    record.finishedAt = new Date().toISOString();
    log(`    ✖ could not load filing: ${record.error}`);
    return { record, trades: [] };
  }

  record.pageCount = pages.length;
  await fs.mkdir(artifactDir, { recursive: true });
  const trades: FMPTrade[] = [];

  for (let i = 0; i < pages.length; i++) {
    const pageNo = i + 1;
    const attempt = await ocrPageWithRotations(pages[i], filing.chamber, ocr, earliestPlausibleDate(filing.filingDate));
    const { valid, rejected, skipped } = attempt.validation;

    let status: PageStatus;
    if (attempt.ocr.error && valid.length === 0) status = "error";
    else if (attempt.quality < MIN_PAGE_QUALITY) status = "needs-review";
    else if (valid.length === 0) status = "empty";
    else status = "ok";

    record.pages.push({
      page: pageNo,
      rotation: attempt.rotation,
      attempts: attempt.attempts,
      seconds: attempt.seconds,
      status,
      quality: Math.round(attempt.quality * 100) / 100,
      validRows: valid.length,
      rejectedRows: rejected.length,
      skippedRows: skipped,
      error: attempt.ocr.error,
    });

    const artifact = path.join(artifactDir, `page-${pageNo}`);
    await fs.writeFile(
      `${artifact}.json`,
      JSON.stringify(
        {
          page: pageNo, status, rotation: attempt.rotation, attempts: attempt.attempts, quality: attempt.quality,
          readable: attempt.ocr.readable, error: attempt.ocr.error, valid, rejected, skipped, raw: attempt.ocr.raw,
        },
        null,
        2
      )
    );
    if (status === "needs-review" || status === "error") await fs.writeFile(`${artifact}.png`, attempt.image.png);
    if (status === "ok" || status === "needs-review") trades.push(...valid.map((row) => toTrade(row, filing, pageNo)));

    log(
      `    page ${pageNo}/${pages.length}  ${status.toUpperCase().padEnd(12)} rot=${attempt.rotation}` +
      `  rows=${valid.length} rejected=${rejected.length} headers=${skipped}  quality=${Math.round(attempt.quality * 100)}%` +
      `  ${attempt.seconds}s${attempt.attempts > 1 ? ` (${attempt.attempts} rotations tried)` : ""}` +
      (attempt.ocr.error ? `  error: ${attempt.ocr.error}` : "")
    );
    for (const r of rejected.slice(0, 8)) {
      log(`      rejected: "${r.row.asset ?? ""}" ${r.row.transactionDate ?? ""} ${r.row.amount ?? ""} — ${r.problems.join("; ")}`);
    }
    if (rejected.length > 8) log(`      … ${rejected.length - 8} more rejected rows in ${artifact}.json`);
  }

  const errors = record.pages.filter((p) => p.status === "error").length;
  const unresolved = record.pages.filter((p) => p.status === "needs-review" || p.status === "error").length;
  record.status = pages.length > 0 && errors === pages.length ? "failed" : unresolved > 0 ? "needs-review" : "done";
  record.trades = trades.length;
  record.finishedAt = new Date().toISOString();
  return { record, trades };
}

/**
 * Put a filing's OCR rows into the trade data. A cleanly OCR'd filing replaces rows
 * already stored for it (e.g. partial rows from an older source). A filing with
 * pages needing review only adds rows when nothing is stored for it yet, so partial
 * OCR never overwrites more complete data.
 */
export function mergeOcrTrades(tradeData: StoredTrades, outcome: FilingOcrOutcome): boolean {
  const { record, trades } = outcome;
  if (trades.length === 0 || record.status === "failed") return false;

  const key = record.chamber === "house" ? "houseTrades" : "senateTrades";
  const existing = tradeData[key].filter((t) => t.link === record.url);
  if (record.status !== "done" && existing.length > 0) return false;

  // Rows replacing earlier ones for the same filing keep the earliest firstSeen, so
  // re-reading a filing doesn't make its trades new again. Earlier rows without one
  // predate the field and stay unstamped.
  const firstSeen = existing.length
    ? existing.map((t) => t.firstSeen).filter((s): s is string => !!s).sort()[0]
    : new Date().toISOString();
  const stamped = trades.map((t) => (firstSeen ? { ...t, firstSeen } : t));
  tradeData[key] = [...tradeData[key].filter((t) => t.link !== record.url), ...stamped];
  return true;
}

/** OCR one filing, merge its rows into trades.json, and record the outcome. */
export async function ocrAndMerge(
  filing: ReviewFiling,
  opts: { ocr: OcrOptions; log: Log; pages?: PageSource[] }
): Promise<FilingOcrOutcome> {
  const outcome = await ocrFiling(filing, opts);
  const stored = await loadData<StoredTrades>(TRADES_FILE);
  if (stored?.data) {
    outcome.record.merged = mergeOcrTrades(stored.data, outcome);
    if (outcome.record.merged) await saveData(TRADES_FILE, stored.data);
  }
  await saveOcrRecord(outcome.record);
  return outcome;
}

/**
 * Daily-run OCR: process scanned filings that haven't been attempted yet, within a page
 * budget (OCR_DAILY_MAX_PAGES, default 60) so one large scan can't stall the pipeline.
 * Larger filings are left for `ocr:catchup`. Never throws. Returns trades merged.
 */
export async function runDailyOcr(log: Log = (line) => console.log(line)): Promise<number> {
  const maxPages = Number(process.env.OCR_DAILY_MAX_PAGES ?? 60);
  try {
    const results = await loadOcrResults();
    const pending = (await loadScannedFilings()).filter((f) => !results[filingKey(f)]);
    if (pending.length === 0) return 0;

    const ocr = ocrOptionsFromEnv();
    const problem = await checkOllama(ocr);
    if (problem) {
      log(`⚠️  OCR skipped for ${pending.length} scanned filing(s): ${problem}`);
      return 0;
    }

    log(`\n🔎 OCR: ${pending.length} scanned filing(s) not yet processed; budget ${maxPages} page(s) with ${ocr.model}`);
    let pagesUsed = 0;
    let merged = 0;
    const deferred: string[] = [];

    for (const filing of pending) {
      let pages: PageSource[];
      try {
        pages = await loadFilingPages(filing);
      } catch (err) {
        log(`  ✖ ${filing.member} ${filing.id}: ${(err as Error).message} — will retry next run`);
        continue;
      }
      if (pagesUsed + pages.length > maxPages) {
        deferred.push(`${filing.member} ${filing.id} (${pages.length}p)`);
        continue;
      }

      log(`  ${filing.member} ${filing.id} — ${filing.chamber}, ${pages.length} page(s)`);
      const outcome = await ocrAndMerge(filing, { ocr, log, pages });
      pagesUsed += pages.length;
      if (outcome.record.merged) merged += outcome.trades.length;
      log(
        `  → ${outcome.record.status}: ${outcome.trades.length} trade(s) ${outcome.record.merged ? "merged" : "not merged"}` +
        ` (details in ${outcome.record.artifactDir})`
      );
    }

    if (deferred.length > 0) {
      log(`  ⏭ ${deferred.length} filing(s) exceed today's OCR page budget — run ocr:catchup: ${deferred.slice(0, 5).join(", ")}${deferred.length > 5 ? " …" : ""}`);
    }
    return merged;
  } catch (err) {
    log(`⚠️  OCR step failed, continuing without it: ${(err as Error).message}`);
    return 0;
  }
}
