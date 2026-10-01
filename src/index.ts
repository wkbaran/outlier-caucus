#!/usr/bin/env node

import { config } from "dotenv";
import { Command } from "commander";
import { fetchCommitteesCommand } from "./commands/fetch-committees.js";
import { fetchTradesCommand } from "./commands/fetch-trades.js";
import { fetchTaxonomyCommand } from "./commands/fetch-taxonomy.js";
import { analyzeCommand } from "./commands/analyze.js";
import { statusCommand } from "./commands/status.js";
import { runCommand } from "./commands/run.js";
import { listCommitteesCommand } from "./commands/list-committees.js";
import { listTradesCommand } from "./commands/list-trades.js";
import { reportSalesCommand } from "./commands/report-sales.js";
import { reportHtmlCommand } from "./commands/report-html.js";
import { ocrCatchupCommand } from "./commands/ocr-catchup.js";
import { ocrCheckTickersCommand } from "./commands/ocr-check-tickers.js";
import { attentionReviewCommand } from "./commands/attention-review.js";

// Load environment variables
config();

// Scheduled runs capture stdout and stderr through one pipe, where the two
// streams can interleave out of order; send warnings/errors to stdout instead.
// Exit codes are unaffected, so failures are still detected.
if (process.env.LOG_TO_STDOUT) {
  console.warn = console.log;
  console.error = console.log;
}

const program = new Command();

program
  .name("outlier-caucus")
  .description("Scores stock trades disclosed by members of Congress for how unusual they are")
  .version("1.0.0");

// Register commands
program.addCommand(fetchCommitteesCommand);
program.addCommand(fetchTradesCommand);
program.addCommand(fetchTaxonomyCommand);
program.addCommand(analyzeCommand);
program.addCommand(statusCommand);
program.addCommand(runCommand);
program.addCommand(listCommitteesCommand);
program.addCommand(listTradesCommand);
program.addCommand(reportSalesCommand);
program.addCommand(reportHtmlCommand);
program.addCommand(ocrCatchupCommand);
program.addCommand(ocrCheckTickersCommand);
program.addCommand(attentionReviewCommand);

// Parse arguments
program.parse();
