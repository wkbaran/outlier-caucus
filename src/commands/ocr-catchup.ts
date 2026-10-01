import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import {
  filingKey, loadOcrResults, loadScannedFilings, ocrAndMerge, OCR_ARTIFACT_DIR,
  type FilingOcrOutcome, type Log,
} from "../ocr/ocr-filings.js";
import { checkOllama, ocrOptionsFromEnv } from "../ocr/ocr-page.js";

const pad = (n: number) => String(n).padStart(2, "0");

function timestamp(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  return h > 0 ? `${h}h${pad(Math.floor((s % 3600) / 60))}m` : `${Math.floor(s / 60)}m${pad(s % 60)}s`;
}

/** Console + UTF-8 log file */
function createLogger(file: string): Log {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return (line) => {
    console.log(line);
    fs.appendFileSync(file, `${line}\n`, "utf-8");
  };
}

const collect = (value: string, previous: string[]) => [...previous, value];

export const ocrCatchupCommand = new Command("ocr:catchup")
  .description("OCR scanned House PTRs and Senate paper filings from the review list, logging every page for review")
  .option("--limit <n>", "Process at most this many filings")
  .option("--filing <id>", "Only this filing id (repeatable)", collect, [] as string[])
  .option("--chamber <chamber>", "Only house or senate filings")
  .option("--retry", "Also reprocess filings whose last OCR failed or has pages needing review")
  .option("--force", "Reprocess every selected filing, including ones already done")
  .option("--model <name>", "Ollama vision model (default: OCR_MODEL env or qwen3.6:27b)")
  .option("--page <n>", "Re-read only this page of the one --filing given (repeatable); replaces that page's rows if it reads cleanly", collect, [] as string[])
  .option("--list", "List the filings that would be processed, then exit")
  .action(async (options) => {
    const ocr = ocrOptionsFromEnv();
    if (options.model) ocr.model = options.model as string;

    const onlyPages = (options.page as string[]).map(Number);
    if (onlyPages.length && ((options.filing as string[]).length !== 1 || onlyPages.some((n) => !Number.isInteger(n) || n < 1))) {
      console.error("❌ --page takes page numbers and needs exactly one --filing.");
      process.exit(1);
    }

    const results = await loadOcrResults();
    // An explicit --chamber or --filing selection overrides OCR_CHAMBERS, so a disabled
    // chamber can still be OCR'd on purpose (e.g. to test a new model on Senate forms)
    const onlyIds = options.filing as string[];
    const chambers = options.chamber
      ? [options.chamber as "house" | "senate"]
      : onlyIds.length > 0 ? (["house", "senate"] as const).slice() : undefined;
    let filings = await loadScannedFilings(chambers);
    if (onlyIds.length > 0) filings = filings.filter((f) => onlyIds.includes(f.id));
    filings = filings.filter((f) => {
      const previous = results[filingKey(f)];
      if (!previous || options.force || onlyPages.length) return true;
      return options.retry && previous.status !== "done";
    });
    if (options.limit) filings = filings.slice(0, parseInt(options.limit as string, 10));

    if (options.list) {
      console.log(`${filings.length} filing(s) selected:`);
      for (const f of filings) {
        const previous = results[filingKey(f)];
        console.log(`  ${f.chamber.padEnd(6)} ${f.id.padEnd(38)} ${f.member.padEnd(32)} ${previous ? `last: ${previous.status}` : "not yet processed"}`);
      }
      return;
    }

    const logFile = path.join("logs", `ocr-catchup-${timestamp()}.log`);
    const log = createLogger(logFile);
    log(`=== OCR catch-up ${new Date().toLocaleString()} ===`);
    log(`model ${ocr.model} at ${ocr.url}; ${filings.length} filing(s) selected; page artifacts in ${OCR_ARTIFACT_DIR}`);

    if (filings.length === 0) {
      log("Nothing to do (use --retry or --force to reprocess earlier results).");
      return;
    }
    const problem = await checkOllama(ocr);
    if (problem) {
      log(`✖ ${problem}`);
      process.exitCode = 1;
      return;
    }

    const started = Date.now();
    const outcomes: FilingOcrOutcome[] = [];

    for (const [i, filing] of filings.entries()) {
      const filingStarted = Date.now();
      log(`\n[${i + 1}/${filings.length}] ${filing.member} — ${filing.chamber} ${filing.id} filed ${filing.filingDate || "?"}`);
      log(`    ${filing.url}`);
      const outcome = await ocrAndMerge(filing, { ocr, log, onlyPages: onlyPages.length ? onlyPages : undefined });
      outcomes.push(outcome);
      const { record } = outcome;
      log(
        `    → ${record.status.toUpperCase()}: ${record.trades} trade(s) ${record.merged ? "merged into trades.json" : "not merged"}` +
        `, ${record.pageCount} page(s) in ${duration(Date.now() - filingStarted)}` +
        (record.error ? ` — ${record.error}` : "")
      );
    }

    // ── Summary ────────────────────────────────────────────────────────────
    const pages = outcomes.flatMap((o) => o.record.pages.map((p) => ({ ...p, record: o.record })));
    const count = (status: string) => pages.filter((p) => p.status === status).length;
    const byStatus = (status: string) => outcomes.filter((o) => o.record.status === status).length;

    log(`\n=== Summary (${duration(Date.now() - started)}) ===`);
    log(`filings: ${byStatus("done")} done, ${byStatus("needs-review")} need review, ${byStatus("failed")} failed`);
    log(`pages:   ${count("ok")} ok, ${count("empty")} empty, ${count("needs-review")} need review, ${count("error")} error`);
    log(`trades:  ${outcomes.filter((o) => o.record.merged).reduce((n, o) => n + o.trades.length, 0)} merged; ` +
      `${outcomes.filter((o) => !o.record.merged && o.trades.length > 0).reduce((n, o) => n + o.trades.length, 0)} held back (filing already has rows and OCR was incomplete)`);

    const failedFilings = outcomes.filter((o) => o.record.status === "failed");
    if (failedFilings.length > 0) {
      log(`\nFailed filings:`);
      for (const { record } of failedFilings) log(`  ${record.member} ${record.chamber} ${record.id}: ${record.error ?? "every page errored"}`);
    }

    const reviewPages = pages.filter((p) => p.status === "needs-review" || p.status === "error");
    if (reviewPages.length > 0) {
      log(`\nPages to review (image + model output):`);
      for (const p of reviewPages) {
        const base = path.join(p.record.artifactDir, `page-${p.page}`);
        log(`  ${p.record.member} ${p.record.id} page ${p.page}: ${p.status} (quality ${Math.round(p.quality * 100)}%${p.error ? `, ${p.error}` : ""}) → ${base}.png / ${base}.json`);
      }
    }

    log(`\nLog: ${logFile}`);
    log("Regenerate and publish the report to include merged OCR trades: node dist/index.js report:html --no-fetch-trades --publish");
  });
