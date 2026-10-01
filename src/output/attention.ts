import * as fs from "fs/promises";
import * as path from "path";
import type { FMPTrade } from "../types/index.js";
import type { ReviewFiling } from "../data/government-provider.js";
import { looksLikeListedStock } from "../data/sec-symbols.js";
import { overrideKey, TICKER_OVERRIDES_FILE, type OcrFilingRecord } from "../ocr/ocr-filings.js";

// What a run could not resolve on its own, each with how to fix it for the next run.
// Shown in the brief, at the foot of the report, and in the run log.

export type AttentionKind = "ocr-failed" | "ocr-needs-review" | "ocr-pending" | "ticker-unresolved" | "ticker-checks-off";

export interface AttentionItem {
  /** Stable while the problem stays the same; marking it reviewed hides it until it changes */
  key: string;
  kind: AttentionKind;
  /** Touches a trade newly disclosed in this report */
  inThisReport: boolean;
  title: string;
  detail: string;
  /** Trades affected; for a pending filing, unknown until it's read */
  trades: number | null;
  member?: string;
  filing?: string;
  asset?: string;
  /** Steps to resolve it before the next run; commands, paths and JSON are in `backticks` */
  fix: string[];
}

export interface AttentionInputs {
  trades: FMPTrade[];
  isNewlyDisclosed: (trade: FMPTrade) => boolean;
  ocrResults: Record<string, OcrFilingRecord>;
  /** Scanned filings in enabled chambers that OCR hasn't attempted yet */
  pendingFilings: ReviewFiling[];
  /** False when the SEC symbol lists couldn't be loaded */
  tickerChecksOn: boolean;
  /** The report date, for the rebuild command */
  reportDate: string;
}

const CLI = "node dist/index.js";
const ORDER: AttentionKind[] = ["ticker-checks-off", "ocr-failed", "ocr-needs-review", "ocr-pending", "ticker-unresolved"];
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function ocrFilingItems(inputs: AttentionInputs): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const record of Object.values(inputs.ocrResults)) {
    if (record.status === "done") continue;
    const rows = inputs.trades.filter((t) => t.link === record.url);
    const inThisReport = rows.some(inputs.isNewlyDisclosed);
    const id = record.id;
    if (record.status === "failed") {
      items.push({
        key: `ocr-failed:${record.chamber}:${id}`,
        kind: "ocr-failed", inThisReport, trades: 0, member: record.member, filing: record.url,
        title: `${record.member}'s scanned filing of ${record.filingDate} couldn't be read`,
        detail: `OCR failed${record.error ? `: ${record.error}` : ""}. Its trades are missing from the report.`,
        fix: [
          "Check that Ollama is reachable at `OLLAMA_URL` and has the OCR model installed.",
          `Re-read it: \`${CLI} ocr:catchup --retry --filing ${id}\``,
        ],
      });
      continue;
    }
    const pages = record.pages.filter((p) => p.status === "needs-review" || p.status === "error").map((p) => p.page);
    items.push({
      // The pages are part of the key, so a different set of bad pages shows up again
      key: `ocr-review:${record.chamber}:${id}:pages-${pages.join("-")}`,
      kind: "ocr-needs-review", inThisReport, trades: rows.length, member: record.member, filing: record.url,
      title: `${record.member}'s scanned filing of ${record.filingDate}: ${pages.length === 1 ? "page" : "pages"} ${pages.join(", ")} read poorly`,
      detail: `${plural(rows.length, "trade")} came from it, but some rows on ${pages.length === 1 ? "that page" : "those pages"} were rejected, so trades may be missing or wrong.`,
      fix: [
        `Compare ${pages.map((p) => `\`logs/ocr/${record.chamber}-${id}/page-${p}.png\``).join(", ")} with the filing.`,
        `If the scan is legible, re-read ${pages.length === 1 ? "that page" : "those pages"}: \`${CLI} ocr:catchup --filing ${id} ${pages.map((p) => `--page ${p}`).join(" ")}\` (add \`--model <name>\` to try another model). A page that then reads cleanly replaces its old rows.`,
        "If the scan itself is illegible, nothing more can be read from it; the rows that were readable are already in.",
      ],
    });
  }
  return items;
}

function pendingItem(inputs: AttentionInputs): AttentionItem[] {
  const pending = inputs.pendingFilings;
  if (!pending.length) return [];
  const names = [...new Set(pending.map((f) => f.member))];
  return [{
    key: `ocr-pending:${pending.map((f) => `${f.chamber}:${f.id}`).sort().join(",")}`,
    kind: "ocr-pending", inThisReport: false, trades: null,
    title: `${plural(pending.length, "scanned filing")} waiting for OCR`,
    detail: `From ${names.slice(0, 5).join(", ")}${names.length > 5 ? ` and ${names.length - 5} more` : ""}. Their trades aren't in the report yet. The daily run reads up to OCR_DAILY_MAX_PAGES pages, so a large filing waits.`,
    fix: [
      `Read them now: \`${CLI} ocr:catchup\` (about 100 seconds a page), or raise \`OCR_DAILY_MAX_PAGES\`.`,
      `Then rebuild the report: \`${CLI} report:html --no-fetch-trades --date ${inputs.reportDate} --publish\``,
    ],
  }];
}

function tickerItems(inputs: AttentionInputs): AttentionItem[] {
  const groups = new Map<string, FMPTrade[]>();
  for (const trade of inputs.trades) {
    if (trade.source !== "ocr" || trade.tickerCheck === "manual") continue;
    const asset = trade.assetDescription ?? "";
    const unresolved = trade.tickerCheck === "unknown-symbol" || trade.tickerCheck === "name-mismatch"
      || (!trade.symbol && looksLikeListedStock(asset));
    if (!unresolved) continue;
    const key = overrideKey(asset);
    groups.set(key, [...(groups.get(key) ?? []), trade]);
  }

  return [...groups.values()].map((rows) => {
    const first = rows[0];
    const asset = first.assetDescription ?? "";
    const read = first.ocrTicker || first.symbol;
    const detail = first.tickerCheck === "unknown-symbol"
      ? `Read as ${read}, which isn't a listed company or fund on the SEC's lists: an OTC or foreign listing, a delisted company, or a misread.`
      : first.tickerCheck === "name-mismatch"
        ? `Read as ${read}, which the SEC lists for a differently named company. Kept because the filing writes it.`
        : "Reads as a listed stock, but the name matched no single listed company, so it has no ticker and gets no company size, sector or committee score.";
    return {
      key: `ticker:${overrideKey(asset)}`,
      kind: "ticker-unresolved" as const,
      inThisReport: rows.some(inputs.isNewlyDisclosed),
      trades: rows.length, asset,
      member: [...new Set(rows.map((t) => `${t.firstName ?? ""} ${t.lastName ?? ""}`.trim()))].join(", "),
      title: `No confirmed ticker for "${asset}"`,
      detail,
      fix: [
        `Add it to \`${TICKER_OVERRIDES_FILE}\`: \`${JSON.stringify({ [asset]: "TICKER" })}\`, with \`""\` if it has no listed ticker.`,
        `Apply it to the stored trades: \`${CLI} ocr:check-tickers --write\`. The next published report includes it; to update this one now, \`${CLI} report:html --no-fetch-trades --date ${inputs.reportDate} --publish\``,
      ],
    };
  });
}

export function buildAttention(inputs: AttentionInputs): AttentionItem[] {
  const items: AttentionItem[] = [];
  if (!inputs.tickerChecksOn) {
    items.push({
      key: "ticker-checks-off",
      kind: "ticker-checks-off", inThisReport: false, trades: null,
      title: "OCR'd tickers weren't checked against the SEC symbol lists",
      detail: "The SEC lists couldn't be loaded, so misread tickers from scanned filings go unchecked.",
      fix: ["Set `SEC_USER_AGENT` (a name and email the SEC can contact) and make sure www.sec.gov is reachable."],
    });
  }
  items.push(...ocrFilingItems(inputs), ...pendingItem(inputs), ...tickerItems(inputs));
  for (const item of items) {
    item.fix.push(`If it's been looked into and needs nothing more, mark it reviewed: \`${CLI} attention:review "${item.key}" --note "<why>"\``);
  }
  return items.sort((a, b) =>
    Number(b.inThisReport) - Number(a.inThisReport)
    || ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind)
    || (b.trades ?? 0) - (a.trades ?? 0));
}

// ── Reviewed items ──────────────────────────────────────────────────────────

export const REVIEWED_FILE = path.join("data", "reviewed-attention.json");

export interface ReviewNote {
  note: string;
  reviewedAt: string;
}

/** Items marked reviewed, by key: a plain JSON object in data/reviewed-attention.json. */
export async function loadReviewed(file = REVIEWED_FILE): Promise<Record<string, ReviewNote>> {
  try {
    return JSON.parse(await fs.readFile(file, "utf-8")) as Record<string, ReviewNote>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`⚠️  Ignoring ${file}: ${(err as Error).message}`);
    return {};
  }
}

export async function saveReviewed(reviewed: Record<string, ReviewNote>, file = REVIEWED_FILE): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(reviewed, null, 2)}\n`, "utf-8");
}

/** Split items into those still open and those someone marked reviewed. */
export function splitReviewed(items: AttentionItem[], reviewed: Record<string, ReviewNote>): { open: AttentionItem[]; hidden: AttentionItem[] } {
  return {
    open: items.filter((i) => !reviewed[i.key]),
    hidden: items.filter((i) => reviewed[i.key]),
  };
}
