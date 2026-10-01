/**
 * OCR one rendered page of a scanned PTR with a local Ollama vision model, and
 * validate the result. Validation is strict on purpose: a row only becomes a trade
 * when its date, amount range, and transaction type all normalize to known values.
 */
import * as http from "http";
import * as https from "https";
import { extractTickerFromDescription } from "../data/ticker-extract.js";

export type FormKind = "house" | "senate";

export interface OcrOptions {
  url: string;
  model: string;
  timeoutMs: number;
  /** Bearer token for an Ollama behind an authenticating proxy; unset for a plain local Ollama */
  apiKey?: string;
}

export function ocrOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): OcrOptions {
  return {
    url: (env.OLLAMA_URL ?? "http://localhost:11434").replace(/\/+$/, ""),
    model: env.OCR_MODEL ?? "qwen3.6:27b",
    timeoutMs: Number(env.OCR_TIMEOUT_MS ?? 10 * 60 * 1000),
    apiKey: env.OLLAMA_API_KEY || undefined,
  };
}

function authHeaders(opts: OcrOptions): Record<string, string> {
  return opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {};
}

/** A row as the model returns it */
export interface OcrRow {
  owner?: string | null;
  asset?: string | null;
  ticker?: string | null;
  type?: string | null;
  transactionDate?: string | null;
  notificationDate?: string | null;
  amount?: string | null;
}

export interface ValidRow {
  owner?: "Spouse" | "DC" | "JT";
  asset: string;
  ticker?: string;
  type: "Purchase" | "Sale (Full)" | "Sale (Partial)" | "Exchange";
  /** YYYY-MM-DD */
  transactionDate: string;
  amount: string;
}

export interface RejectedRow {
  row: OcrRow;
  problems: string[];
}

export interface Validation {
  valid: ValidRow[];
  rejected: RejectedRow[];
  /** Account/section header rows with no date, amount, or type */
  skipped: number;
}

export const AMOUNT_RANGES = [
  "$1,001 - $15,000", "$15,001 - $50,000", "$50,001 - $100,000", "$100,001 - $250,000",
  "$250,001 - $500,000", "$500,001 - $1,000,000", "$1,000,001 - $5,000,000",
  "$5,000,001 - $25,000,000", "$25,000,001 - $50,000,000",
];
const OVER_50M = "Over $50,000,000";
const SPOUSE_OVER_1M = "Spouse/DC Over $1,000,000";

// Column letters on the House paper form
const HOUSE_AMOUNT_LETTERS: Record<string, string> = {
  A: AMOUNT_RANGES[0], B: AMOUNT_RANGES[1], C: AMOUNT_RANGES[2], D: AMOUNT_RANGES[3],
  E: AMOUNT_RANGES[4], F: AMOUNT_RANGES[5], G: AMOUNT_RANGES[6], H: AMOUNT_RANGES[7],
  I: AMOUNT_RANGES[8], J: OVER_50M, K: SPOUSE_OVER_1M,
};

const RANGE_BOUNDS = AMOUNT_RANGES.map((range) => {
  const [low, high] = [...range.matchAll(/\$([\d,]+)/g)].map((m) => Number(m[1].replace(/,/g, "")));
  return { range, low, high };
});

/** Map an amount as read ("$15,001 - $50,000", "$1 000-$15 000", "B") to a standard range. */
export function normalizeAmount(raw: string | null | undefined): string | undefined {
  const text = String(raw ?? "").trim();
  if (!text) return undefined;
  if (/^[A-K]$/i.test(text)) return HOUSE_AMOUNT_LETTERS[text.toUpperCase()];

  // Forms print thousands with commas or spaces
  const numbers = [...text.matchAll(/\d{1,3}(?:[ ,]\d{3})+|\d+/g)].map((m) => Number(m[0].replace(/\D/g, "")));
  if (numbers.length === 0) return undefined;

  if (/over/i.test(text)) {
    if (numbers[0] >= 50_000_000) return OVER_50M;
    if (numbers[0] === 1_000_000) return SPOUSE_OVER_1M;
    return undefined;
  }

  // Lower bounds are printed as either "$1,001" or "$1,000"
  const match = RANGE_BOUNDS.find((b) => numbers[0] === b.low || numbers[0] === b.low - 1);
  if (!match) return undefined;
  if (numbers.length >= 2 && numbers[1] !== match.high) return undefined;
  return match.range;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Parse M/D/YY or MM/DD/YYYY into YYYY-MM-DD; undefined if invalid or implausible for a PTR. */
export function normalizeDate(raw: string | null | undefined, now = new Date()): string | undefined {
  const m = String(raw ?? "").match(/(\d{1,2})\s*[/.-]\s*(\d{1,2})\s*[/.-]\s*(\d{4}|\d{2})\b/);
  if (!m) return undefined;
  const month = Number(m[1]);
  const day = Number(m[2]);
  const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);

  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;

  // A PTR reports past transactions, and the STOCK Act disclosure regime began in 2012
  const tomorrow = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (date.getTime() < Date.UTC(2012, 0, 1) || date.getTime() > tomorrow) return undefined;

  return `${year}-${pad(month)}-${pad(day)}`;
}

export function normalizeType(raw: string | null | undefined): ValidRow["type"] | undefined {
  const t = String(raw ?? "").trim().toLowerCase();
  if (!t) return undefined;
  if (t.includes("partial")) return "Sale (Partial)";
  if (t.startsWith("p")) return "Purchase";
  if (t.startsWith("s")) return "Sale (Full)";
  if (t.startsWith("e")) return "Exchange";
  return undefined;
}

function normalizeOwner(raw: string | null | undefined): ValidRow["owner"] {
  const o = String(raw ?? "").trim().toUpperCase().replace(/[().]/g, "");
  if (o === "SP" || o === "S" || o === "SPOUSE") return "Spouse";
  if (o === "DC" || o.startsWith("DEPENDENT")) return "DC";
  if (o === "JT" || o === "J" || o === "JOINT") return "JT";
  return undefined;
}

function cleanTicker(raw: string | null | undefined): string | undefined {
  const t = String(raw ?? "").trim().toUpperCase();
  return /^[A-Z]{1,5}(?:[./-][A-Z])?$/.test(t) ? t : undefined;
}

/**
 * The ticker written in the asset name wins over the model's ticker field: the
 * model sometimes copies the House asset-type code there ("ST" from "[ST]") even
 * when the name says "(MRSH)". A model ticker that is the row's asset-type code
 * or a share-class code is dropped.
 */
export function rowTicker(asset: string, raw: string | null | undefined): string | undefined {
  const written = extractTickerFromDescription(asset);
  if (written) return written;
  const ticker = cleanTicker(raw);
  if (!ticker || SHARE_CLASS_CODES.has(ticker)) return undefined;
  return asset.toUpperCase().includes(`[${ticker}]`) ? undefined : ticker;
}

// Share-class columns on broker statements that the model reads as tickers:
// one member's statements gave 198 different companies the ticker "CMN".
const SHARE_CLASS_CODES = new Set(["CMN", "COM", "ORD", "PFD", "SHS"]);

/**
 * Two securities run together in one asset name, "CVS HEALTH CORP CMN EDWARDS
 * LIFESCIENCES CORPORATI CMN": the model joined a wrapped name to the row above and
 * dropped that row's own trade. Option descriptions ("... Common Stock Option Type:
 * Call ...", "... CMN CALL/UBS FLEX ...") continue after the share class legitimately.
 */
export function looksLikeMergedRows(asset: string): boolean {
  return /\b(?:CMN|COMMON STOCK)\b\.?(?:\s+CL(?:ASS)?[\s-]*[A-Z]\b)?\s+(?!CL(?:ASS)?\b|OPTION\b|CALL\b|PUT\b)[A-Z][A-Z0-9&.,'/-]*\s+[A-Z0-9]/i.test(asset);
}

export const MERGED_ROWS_PROBLEM = "two rows' asset names run together; the page must be re-read";

/**
 * @param earliest YYYY-MM-DD; transaction dates before it are rejected as misreads
 *   (e.g. a date well before the filing was submitted)
 */
export function validateRows(rows: OcrRow[], now = new Date(), earliest?: string): Validation {
  const valid: ValidRow[] = [];
  const rejected: RejectedRow[] = [];
  let skipped = 0;

  for (const row of rows) {
    // Header rows, the sample row both paper forms print ("Example Mega Corp", IBM "EXAMPLE"),
    // and cover-page notes that point to attached statements
    if ((!row.transactionDate && !row.amount && !row.type) || /\bexample\b|please see (the )?attached/i.test(String(row.asset ?? ""))) {
      skipped++;
      continue;
    }

    let asset = String(row.asset ?? "").replace(/\s+/g, " ").trim();
    let owner = normalizeOwner(row.owner);
    // Senate paper forms prefix the owner onto the asset name: "(S) MH Four Winds LLC"
    const prefix = asset.match(/^\((S|SP|DC|J|JT)\)\s*/i);
    if (prefix) {
      owner ??= normalizeOwner(prefix[1]);
      asset = asset.slice(prefix[0].length);
    }

    const date = normalizeDate(row.transactionDate, now);
    const amount = normalizeAmount(row.amount);
    const type = normalizeType(row.type);

    const problems: string[] = [];
    if (!asset) problems.push("missing asset name");
    else if (looksLikeMergedRows(asset)) problems.push(MERGED_ROWS_PROBLEM);
    if (!date) problems.push(`unreadable or implausible date "${row.transactionDate ?? ""}"`);
    else if (earliest && date < earliest) problems.push(`date ${date} is implausibly long before the filing`);
    if (!amount) problems.push(`unrecognized amount "${row.amount ?? ""}"`);
    if (!type) problems.push(`unrecognized type "${row.type ?? ""}"`);
    if (problems.length > 0 || !date || !amount || !type) {
      rejected.push({ row, problems });
      continue;
    }

    valid.push({
      owner,
      asset,
      ticker: rowTicker(asset, row.ticker),
      type,
      transactionDate: date,
      amount,
    });
  }

  return { valid, rejected, skipped };
}

/** Pages at or above this share of validated rows are trusted; below it they need review */
export const MIN_PAGE_QUALITY = 0.8;

/** Share of transaction rows that validated; a readable page with none scores 1. */
export function pageQuality(validation: Validation, readable: boolean): number {
  const total = validation.valid.length + validation.rejected.length;
  if (total === 0) return readable ? 1 : 0;
  return validation.valid.length / total;
}

/** Extract rows from model output: a JSON array, or `{ page_readable, rows }`, possibly fenced. */
export function parseModelResponse(text: string): { readable: boolean; rows: OcrRow[] } | null {
  const trimmed = text.trim();
  const candidates = [
    trimmed,
    trimmed.slice(trimmed.indexOf("["), trimmed.lastIndexOf("]") + 1),
    trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (Array.isArray(parsed)) return { readable: true, rows: parsed as OcrRow[] };
      const obj = parsed as { page_readable?: boolean; rows?: unknown };
      if (obj && Array.isArray(obj.rows)) return { readable: obj.page_readable !== false, rows: obj.rows as OcrRow[] };
    } catch {
      // try the next candidate
    }
  }
  return null;
}

// These prompts follow the wording that transcribed a 25-row test page with every field
// correct. Don't constrain output with Ollama's JSON-schema `format`: on that page it cut
// accuracy to 15/25, with every row in the second amount column read as the first. Plain
// JSON plus lenient parsing (parseModelResponse) avoids that.
const PROMPTS: Record<FormKind, string> = {
  house: `This is a scanned page of a U.S. House Periodic Transaction Report.
Transcribe every transaction row in the table. Return ONLY a JSON array; each element:
{"owner": "SP|DC|JT|" , "asset": "full asset name as written", "ticker": "ticker if shown, else null",
 "type": "P|S|S (partial)|E", "transactionDate": "MM/DD/YYYY", "notificationDate": "MM/DD/YYYY",
 "amount": "amount range exactly as checked/written, e.g. $1,001 - $15,000"}
The amount is shown by an X in one of the lettered columns, which mean:
A $1,001 - $15,000; B $15,001 - $50,000; C $50,001 - $100,000; D $100,001 - $250,000;
E $250,001 - $500,000; F $500,001 - $1,000,000; G $1,000,001 - $5,000,000;
H $5,000,001 - $25,000,000; I $25,000,001 - $50,000,000; J Over $50,000,000;
K Spouse/DC Amount over $1,000,000. Use the range text, not the letter.
Section header rows that name an account or trust but have no date are not transactions.
The printed example row (for instance "Example Mega Corp Common Stock") is not a transaction.
Each row with its own transaction date is one transaction, so return exactly one element per dated row.
A long asset name can wrap onto two lines inside its own row: the wrapped name's first line sits
just below the row above, but it belongs to the row whose date and X marks are beside it.
Never join the asset names of two rows into one element.
If the page has no transaction rows, return []. Do not guess values you cannot read; use null.`,
  senate: `This is a scanned page of a U.S. Senate Periodic Transaction Report ("Periodic Disclosure of Financial Transactions").
Transcribe every numbered transaction row. Return ONLY a JSON array; each element:
{"owner": "S|DC|J|", "asset": "asset name without the (S)/(DC)/(J) owner prefix", "ticker": "ticker if shown, else null",
 "type": "P|S|S (partial)|E", "transactionDate": "as written, e.g. 7/21/26",
 "amount": "amount range exactly as checked, e.g. $1,001 - $15,000"}
The owner is the (S) spouse, (DC) dependent child, or (J) joint prefix on the asset name; use "" if there is none.
The type is shown by an X in the Purchase, Sale, or Exchange column.
The amount is shown by an X in one of the amount columns, which mean, from left to right:
1 $1,001 - $15,000; 2 $15,001 - $50,000; 3 $50,001 - $100,000; 4 $100,001 - $250,000;
5 $250,001 - $500,000; 6 $500,001 - $1,000,000; 7 Over $1,000,000 (spouse/dependent child assets);
8 $1,000,001 - $5,000,000; 9 $5,000,001 - $25,000,000; 10 $25,000,001 - $50,000,000; 11 Over $50,000,000.
Use the range text, not the column number.
The printed example rows (IBM Corp. and Microsoft, marked E X A M P L E) are not transactions.
Header rows that name an entity (ending in ":") with no X marks are not transactions. Skip empty numbered rows.
If the page has no transaction rows, return []. Do not guess values you cannot read; use null.`,
};

export interface PageOcr {
  readable: boolean;
  rows: OcrRow[];
  raw: string;
  seconds: number;
  error?: string;
}

/**
 * POST to Ollama's chat API and collect the streamed `message.content`. Uses node:http
 * rather than fetch, which aborts when response headers take over 5 minutes: Ollama sends
 * no headers until it starts on a request, and a request queued behind another model on a
 * shared GPU can wait longer than that. Only the overall timeout applies here.
 */
function ollamaChat(url: string, body: unknown, timeoutMs: number, headers: Record<string, string>): Promise<{ status: number; content: string; errorText: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = Buffer.from(JSON.stringify(body));
    const client = target.protocol === "https:" ? https : http;
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const req = client.request(
      target,
      { method: "POST", headers: { ...headers, "Content-Type": "application/json", "Content-Length": payload.length } },
      (res) => {
        const status = res.statusCode ?? 0;
        let buffered = "";
        let content = "";
        let errorText = "";
        // Newline-delimited JSON chunks; non-200 bodies are kept as error text
        const take = (line: string) => {
          if (!line.trim()) return;
          if (status !== 200) {
            errorText += line;
            return;
          }
          const chunk = JSON.parse(line) as { message?: { content?: string }; error?: string };
          if (chunk.error) throw new Error(`Ollama: ${chunk.error}`);
          content += chunk.message?.content ?? "";
        };

        res.setEncoding("utf8");
        res.on("data", (part: string) => {
          buffered += part;
          const lines = buffered.split("\n");
          buffered = lines.pop() ?? "";
          try {
            lines.forEach(take);
          } catch (err) {
            req.destroy(err as Error);
          }
        });
        res.on("end", () => {
          try {
            take(buffered);
            finish(() => resolve({ status, content, errorText }));
          } catch (err) {
            finish(() => reject(err));
          }
        });
        res.on("error", (err) => finish(() => reject(err)));
      }
    );

    const timer = setTimeout(() => req.destroy(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
    req.on("error", (err) => finish(() => reject(err)));
    req.end(payload);
  });
}

export async function ocrPage(png: Buffer, form: FormKind, opts: OcrOptions): Promise<PageOcr> {
  const started = Date.now();
  const seconds = () => Math.round((Date.now() - started) / 100) / 10;

  try {
    const { status, content: raw, errorText } = await ollamaChat(
      `${opts.url}/api/chat`,
      {
        model: opts.model,
        stream: true,
        think: false,
        keep_alive: "15m",
        options: { temperature: 0, num_ctx: 16384 },
        messages: [{ role: "user", content: PROMPTS[form], images: [png.toString("base64")] }],
      },
      opts.timeoutMs,
      authHeaders(opts)
    );
    if (status !== 200) {
      return { readable: false, rows: [], raw: "", seconds: seconds(), error: `Ollama HTTP ${status}: ${errorText.slice(0, 200)}` };
    }
    const parsed = parseModelResponse(raw);
    if (!parsed) return { readable: false, rows: [], raw, seconds: seconds(), error: "model response was not valid JSON" };
    return { ...parsed, raw, seconds: seconds() };
  } catch (err) {
    return { readable: false, rows: [], raw: "", seconds: seconds(), error: (err as Error).message };
  }
}

/** Null when Ollama is reachable and the model is installed; otherwise the reason it isn't usable. */
export async function checkOllama(opts: OcrOptions): Promise<string | null> {
  try {
    const resp = await fetch(`${opts.url}/api/tags`, { headers: authHeaders(opts), signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return `Ollama returned HTTP ${resp.status}`;
    const { models = [] } = (await resp.json()) as { models?: Array<{ name: string }> };
    const wanted = opts.model.includes(":") ? opts.model : `${opts.model}:latest`;
    return models.some((m) => m.name === wanted) ? null : `model ${opts.model} is not installed (ollama pull ${opts.model})`;
  } catch (err) {
    return `Ollama is not reachable at ${opts.url} (${(err as Error).message})`;
  }
}
