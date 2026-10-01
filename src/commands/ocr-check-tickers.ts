import { Command } from "commander";
import { loadData, saveData } from "../utils/storage.js";
import { loadSymbolDirectory } from "../data/sec-symbols.js";
import { checkStoredTickers, loadTickerOverrides, TICKER_OVERRIDES_FILE } from "../ocr/ocr-filings.js";
import type { TradeData } from "../types/index.js";

export const ocrCheckTickersCommand = new Command("ocr:check-tickers")
  .description(`Check the tickers of stored OCR'd trades against ${TICKER_OVERRIDES_FILE}, the SEC symbol lists and their asset names; a dry run unless --write`)
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

    const overrides = await loadTickerOverrides();
    const { data, checked, changes, counts } = checkStoredTickers(stored.data, symbols, overrides);
    const changed = [...changes.values()].reduce((a, b) => a + b, 0);
    console.log(`${checked} OCR'd trades checked, ${changed} tickers changed (${overrides.size} override${overrides.size === 1 ? "" : "s"} in ${TICKER_OVERRIDES_FILE})`);
    for (const [check, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${check.padEnd(15)} ${n}`);
    const show = parseInt(options.show as string, 10);
    for (const [line, n] of [...changes].slice(0, show)) console.log(`  ${n > 1 ? `${n}× ` : ""}${line}`);
    if (changes.size > show) console.log(`  … ${changes.size - show} more`);

    if (options.write) {
      await saveData("trades.json", data);
      console.log("💾 Saved to trades.json");
    } else {
      console.log("Dry run: add --write to save.");
    }
  });
