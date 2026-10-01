import { Command } from "commander";
import { loadData, saveData } from "../utils/storage.js";
import { loadSymbolDirectory } from "../data/sec-symbols.js";
import { applyTickerCheck } from "../ocr/ocr-filings.js";
import type { TradeData } from "../types/index.js";

export const ocrCheckTickersCommand = new Command("ocr:check-tickers")
  .description("Check the tickers of stored OCR'd trades against the SEC symbol lists and their asset names; a dry run unless --write")
  .option("--write", "Save the corrected tickers to trades.json")
  .option("--show <n>", "List at most this many changed tickers", "50")
  .action(async (options) => {
    const symbols = await loadSymbolDirectory();
    if (!symbols) {
      console.error("❌ No SEC symbol lists: set SEC_USER_AGENT so they can be downloaded.");
      process.exit(1);
    }
    const stored = await loadData<TradeData>("trades.json");
    if (!stored?.data) {
      console.error("❌ No trades.json to check.");
      process.exit(1);
    }

    const counts: Record<string, number> = {};
    const changes = new Map<string, number>();
    let checked = 0;
    for (const key of ["houseTrades", "senateTrades"] as const) {
      stored.data[key] = stored.data[key].map((trade) => {
        if (trade.source !== "ocr") return trade;
        checked++;
        const next = applyTickerCheck(trade, symbols);
        counts[next.tickerCheck ?? "no ticker"] = (counts[next.tickerCheck ?? "no ticker"] ?? 0) + 1;
        if (next.symbol !== trade.symbol) {
          const line = `${next.tickerCheck}: ${trade.symbol ?? "none"} → ${next.symbol ?? "none"}  ${trade.assetDescription ?? ""}`;
          changes.set(line, (changes.get(line) ?? 0) + 1);
        }
        return next;
      });
    }

    const changed = [...changes.values()].reduce((a, b) => a + b, 0);
    console.log(`${checked} OCR'd trades checked, ${changed} tickers changed`);
    for (const [check, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${check.padEnd(15)} ${n}`);
    const show = parseInt(options.show as string, 10);
    for (const [line, n] of [...changes].slice(0, show)) console.log(`  ${n > 1 ? `${n}× ` : ""}${line}`);
    if (changes.size > show) console.log(`  … ${changes.size - show} more`);

    if (options.write) {
      await saveData("trades.json", stored.data);
      console.log("💾 Saved to trades.json");
    } else {
      console.log("Dry run: add --write to save.");
    }
  });
