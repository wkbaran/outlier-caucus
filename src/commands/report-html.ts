import { Command } from "commander";
import * as fs from "fs/promises";
import * as path from "path";
import { loadTrades, fetchTrades, getDefaultTargetDate } from "../services/trade-service.js";
import { loadCommitteeData, fetchAllCommitteeData, buildPartyMap, findMemberByName, getMemberParty } from "../services/committee-service.js";
import { analyzeTrades } from "../services/analysis-service.js";
import type { AnalysisReport } from "../services/analysis-service.js";
import { createFMPProvider } from "../data/fmp-provider.js";
import { createFMPClient } from "../services/fmp-client.js";
import { FMPTradeSource } from "../services/fmp-trade-source.js";
import { createGovernmentProvider } from "../data/government-provider.js";
import { createEdgarProvider } from "../data/edgar-provider.js";
import { filingKey, loadOcrResults, loadScannedFilings, runDailyOcr } from "../ocr/ocr-filings.js";
import { loadSymbolDirectory } from "../data/sec-symbols.js";
import { buildAttention } from "../output/attention.js";

function createTradeProvider() {
  if (process.env.DATA_SOURCE === "fmp") {
    return new FMPTradeSource(createFMPClient());
  }
  return createGovernmentProvider();
}

function createMarketDataProvider(cacheOnly: boolean) {
  if (process.env.DATA_SOURCE === "fmp") {
    return createFMPProvider(cacheOnly);
  }
  return createEdgarProvider(cacheOnly);
}
import { buildHtmlReport, buildPartyPage, buildMemberPage, buildScoreLookup, type MemberLinker } from "../output/html.js";
import { createMemberResolver } from "../output/member-identity.js";
import { buildIndexPage, buildHomePage, loadManifest, upsertManifest, rebuildManifest, previousFilingBaseline, previousRanAt } from "../output/index-page.js";
import type { ManifestSymbol, ReportManifestEntry } from "../output/index-page.js";
import { createNewlyDisclosedPredicate, filingDateIso, maxFilingDate } from "../utils/filing-date.js";
import { publishOutput } from "../publish.js";
import { buildBrief } from "../output/brief.js";
import { ROOT_ICONS } from "../output/icons.js";
import { loadData, getLatestReport, getDataAge } from "../utils/storage.js";
import type { FMPTrade } from "../types/index.js";

const DEFAULT_WEB_DIR = "output/web";
const COMMITTEE_DATA_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

/** Load exchange info from the market data cache (populated by --market-data runs). */
async function loadExchangeMap(): Promise<Map<string, string>> {
  const exchangeMap = new Map<string, string>();
  try {
    type CacheEntry = { data: { exchange?: string | null }; fetchedAt: string };
    const cached = await loadData<Record<string, CacheEntry>>("market-data-cache.json");
    if (cached?.data) {
      for (const [sym, entry] of Object.entries(cached.data)) {
        if (entry.data.exchange) exchangeMap.set(sym, entry.data.exchange);
      }
    }
  } catch { /* cache not available */ }
  return exchangeMap;
}

/**
 * The archive lists every report; the site root forwards to the newest one,
 * so the default page is always the latest report. The root also holds the
 * icons that browsers and iOS look for there.
 */
async function writeIndexPages(webDir: string, manifest: ReportManifestEntry[]): Promise<void> {
  await fs.writeFile(path.join(webDir, "archive.html"), buildIndexPage(manifest), "utf-8");
  await fs.writeFile(path.join(webDir, "index.html"), buildHomePage(manifest), "utf-8");
  for (const [file, base64] of Object.entries(ROOT_ICONS)) {
    await fs.writeFile(path.join(webDir, file), Buffer.from(base64, "base64"));
  }
}

export const reportHtmlCommand = new Command("report:html")
  .description("Generate a weekly HTML report and optionally publish to AWS S3")
  .option("--no-fetch-trades", "Use cached trade data instead of fetching fresh")
  .option("--no-ocr", "Skip OCR of scanned/paper filings after fetching (normally up to OCR_DAILY_MAX_PAGES pages per run)")
  .option("--no-market-data", "Skip market data fetching (faster, no market cap scores)")
  .option(
    "--out <dir>",
    `Output directory for HTML files (default: ${DEFAULT_WEB_DIR})`,
    DEFAULT_WEB_DIR
  )
  .option("--date <YYYY-MM-DD>", "Build the report for this date instead of today, replacing that day's report (use with --no-fetch-trades to correct a published report)")
  .option("--render-only", "Re-render HTML from the last saved analysis without re-fetching or re-analyzing")
  .option("--rebuild-index", "Rebuild archive.html and index.html from the manifest (prunes deleted reports) without generating a new report")
  .option("--skip-unchanged", "Skip generating and publishing if fetching found no new trades since the last run (for scheduled/automated runs)")
  .option("--top-window-days <days>", "Only rank trades from this many days back for Top Purchases / Committee-Relevant", "30")
  .option("--publish", "Sync output/web to S3 and invalidate CloudFront after generating")
  .option("--bucket <name>", "S3 bucket name (or set S3_BUCKET env var)")
  .option("--region <region>", "AWS region (default: us-east-1 or AWS_REGION env var)")
  .option("--prefix <prefix>", "S3 key prefix (optional)")
  .action(async (options) => {
    try {
      const webDir = path.resolve(process.cwd(), options.out as string);
      await fs.mkdir(webDir, { recursive: true });

      if (options.date && !/^\d{4}-\d{2}-\d{2}$/.test(options.date as string)) {
        console.error(`❌ --date must be YYYY-MM-DD (got "${options.date}")`);
        process.exit(1);
      }

      const topWindowDays = parseInt(options.topWindowDays as string, 10);
      if (isNaN(topWindowDays) || topWindowDays <= 0) {
        console.error(`❌ --top-window-days must be a positive integer (got "${options.topWindowDays}")`);
        process.exit(1);
      }

      // ── Rebuild-index-only shortcut ──────────────────────────────────────
      if (options.rebuildIndex) {
        console.log("Rebuilding index from manifest...");
        const manifest = await rebuildManifest(webDir);
        await writeIndexPages(webDir, manifest);
        console.log(`✅ archive.html and index.html rebuilt (${manifest.length} report${manifest.length !== 1 ? "s" : ""})`);
        if (options.publish) {
          await publishOutput({ localDir: webDir, bucket: options.bucket, region: options.region, prefix: options.prefix });
        }
        return;
      }

      // ── Load committee data (needed in both paths) ───────────────────────
      // Legislators and committee assignments change (resignations, new members),
      // so refresh them weekly; keep the cached copy if the download fails.
      if (!options.renderOnly) {
        const age = await getDataAge("committee-data.json");
        if (!age.exists || (age.ageMs ?? Infinity) > COMMITTEE_DATA_MAX_AGE_MS) {
          try {
            await fetchAllCommitteeData();
          } catch (err) {
            console.warn(`⚠️  Committee data refresh failed, using cached copy: ${(err as Error).message}`);
          }
        }
      }

      const committeeData = await loadCommitteeData();
      if (!committeeData) {
        console.warn("⚠️  No committee data — run fetch:committees for committee analysis.");
      }

      const partyMap = committeeData?.legislators
        ? buildPartyMap(committeeData.legislators)
        : null;

      function resolveParty(trade: FMPTrade): string | undefined {
        if (!partyMap || !committeeData || !trade.firstName || !trade.lastName) return undefined;
        const id = findMemberByName(
          trade.firstName,
          trade.lastName,
          committeeData.membership,
          committeeData.legislators
        );
        return id ? getMemberParty(id, partyMap) ?? undefined : undefined;
      }

      let report: AnalysisReport;

      // ── Render-only path ─────────────────────────────────────────────────
      if (options.renderOnly) {
        console.log("Render-only mode: loading last saved analysis...");
        const filename = await getLatestReport("unique-trades");
        if (!filename) {
          console.error("❌ No saved analysis found. Run report:html (without --render-only) first.");
          process.exit(1);
        }
        const stored = await loadData<AnalysisReport>(filename, "reports");
        if (!stored?.data) {
          console.error(`❌ Could not load analysis from ${filename}.`);
          process.exit(1);
        }
        report = stored.data;
        console.log(`   Loaded ${filename} (${new Date(stored.fetchedAt).toLocaleString()})`);
      } else {
        // ── Full analysis path ─────────────────────────────────────────────
        let tradeData;
        if (options.fetchTrades) {
          console.log("📥 Fetching fresh trade data...");
          const previousData = await loadTrades();
          const previousCount = previousData
            ? previousData.senateTrades.length + previousData.houseTrades.length
            : 0;

          const targetDate = getDefaultTargetDate();
          tradeData = await fetchTrades(createTradeProvider(), targetDate);
          console.log("");

          // OCR newly found scanned/paper filings (within a daily page budget); it merges
          // rows into trades.json, so reload before counting what changed
          if (options.ocr && (await runDailyOcr()) > 0) {
            tradeData = (await loadTrades()) ?? tradeData;
            console.log("");
          }

          const newCount = tradeData.senateTrades.length + tradeData.houseTrades.length;
          if (options.skipUnchanged && newCount === previousCount) {
            console.log("No new trades since the last run — skipping report generation and publish.");
            return;
          }
        } else {
          console.log("Using cached trade data (omit --no-fetch-trades to refresh)");
          tradeData = await loadTrades();
        }

        if (!tradeData) {
          console.error("❌ No trade data found. Run without --no-fetch-trades to fetch.");
          process.exit(1);
        }

        // When using cached trade data, also use cache-only for market data
        // (no API calls — only load what's already on disk).
        const cacheOnlyMarket = !options.fetchTrades;
        const marketDataProvider = options.marketData ? createMarketDataProvider(cacheOnlyMarket) : null;
        if (!marketDataProvider) {
          console.log("Market data disabled (omit --no-market-data to enable)");
        } else if (cacheOnlyMarket) {
          console.log("Market data: cache-only (no API calls — using --no-fetch-trades)");
        }

        console.log("\nRunning analysis...");
        report = await analyzeTrades(
          tradeData.senateTrades,
          tradeData.houseTrades,
          committeeData,
          marketDataProvider
        );
      }

      // ── Load trade data for sales section ───────────────────────────────
      const tradeData = await loadTrades();
      const allTrades = tradeData
        ? [...tradeData.senateTrades, ...tradeData.houseTrades]
        : [];

      const salesTrades = allTrades
        .filter((t) => (t.type || "").toLowerCase().includes("sale"))
        .sort((a, b) => (b.transactionDate ?? "").localeCompare(a.transactionDate ?? ""))
        .map((trade) => ({ trade, party: resolveParty(trade) }));

      const purchaseTrades = allTrades
        .filter((t) => {
          const type = (t.type || "").toLowerCase();
          return type.includes("purchase") || type.includes("exchange");
        })
        .sort((a, b) => (b.transactionDate ?? "").localeCompare(a.transactionDate ?? ""))
        .map((trade) => ({ trade, party: resolveParty(trade) }));

      // ── Build exchange map for TradingView links ─────────────────────────
      const exchangeMap = await loadExchangeMap();

      // ── Prepare output directory ─────────────────────────────────────────
      // Local date for both the folder and the page labels: a UTC date rolls over
      // mid-evening in US time zones, filing an evening run under tomorrow.
      // --date rebuilds an earlier report under its own date; noon keeps the label on that day.
      const now = options.date ? new Date(`${options.date}T12:00:00`) : new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      const runDateLabel = formatDate(now);

      const dateDir = path.join(webDir, dateStr);
      await fs.mkdir(dateDir, { recursive: true });

      const reportFile = "report.html";
      const reportRelPath = `${dateStr}/report.html`;

      console.log(`\n📄 Building HTML report: ${dateStr}/report.html`);

      // ── What is new since the previous run ───────────────────────────────
      // Filings lag transactions by ~a month, so new disclosures land in the
      // middle of the date-sorted tables, never at the top. Comparing filing
      // dates against the previous run's high-water mark is what makes them
      // findable — as gold rows here and as chips on the archive page.
      const priorManifest = await loadManifest(webDir);
      const filingBaseline = previousFilingBaseline(priorManifest, dateStr);
      // A rebuilt report keeps its original run time, so trades found since stay out of it.
      const ranAt = priorManifest.find((e) => e.date === dateStr && options.date)?.ranAt ?? new Date().toISOString();
      const foundAfter = previousRanAt(priorManifest, dateStr);
      const isNewlyDisclosed = createNewlyDisclosedPredicate(filingBaseline, { foundAfter, foundThrough: ranAt });
      const hasPrevious = filingBaseline !== null || foundAfter !== null;
      const runMaxFiling = maxFilingDate(allTrades);

      const newlyDisclosed = allTrades.filter(isNewlyDisclosed);

      // ── What this run couldn't resolve, with how to fix it ───────────────
      const ocrResults = await loadOcrResults();
      const attention = buildAttention({
        trades: allTrades,
        isNewlyDisclosed,
        ocrResults,
        pendingFilings: (await loadScannedFilings()).filter((f) => !ocrResults[filingKey(f)]),
        tickerChecksOn: (await loadSymbolDirectory()) !== null,
        reportDate: dateStr,
      });
      console.log(
        hasPrevious
          ? `   Newly disclosed since the previous report: ${newlyDisclosed.length} trade${newlyDisclosed.length !== 1 ? "s" : ""}`
          : "   No previous report in manifest - nothing marked new this run"
      );

      // Chips preview the run's new disclosures, deduped by symbol+side so one
      // member unloading a position in six tranches does not fill the row.
      // Symbol-less rows (bonds, options, unparsed OCR) are skipped rather than
      // sliced off, so eight slots always yield eight chips when eight exist.
      const chipSource = hasPrevious
        ? newlyDisclosed
        // Bootstrap: with no baseline nothing can honestly be called new, so
        // preview the most recently *filed* trades instead of leaving the
        // archive row bare. Self-corrects once this run records its high-water
        // mark for the next one to compare against.
        : [...allTrades]
            .sort((a, b) => (filingDateIso(b) ?? "").localeCompare(filingDateIso(a) ?? ""));

      const seenChips = new Set<string>();
      const newSymbols: ManifestSymbol[] = [];
      for (const trade of chipSource) {
        const symbol = trade.symbol;
        if (!symbol) continue;
        const side: ManifestSymbol["side"] =
          (trade.type || "").toLowerCase().includes("sale") ? "sale" : "purchase";
        const key = `${symbol}|${side}`;
        if (seenChips.has(key)) continue;
        seenChips.add(key);
        newSymbols.push({ symbol, side });
        if (newSymbols.length >= 8) break;
      }

      // Legacy field: kept populated so anything still reading it keeps working.
      const topSymbols = newSymbols.map((c) => c.symbol);

      const scoreLookup = buildScoreLookup(report);

      const allPartyTrades = [...purchaseTrades, ...salesTrades]
        .sort((a, b) => (b.trade.transactionDate ?? "").localeCompare(a.trade.transactionDate ?? ""));

      // ── Member pages (built first so we know which files exist) ─────────
      // One resolver decides page identity for both page generation and every
      // link to a member page, so the two can never disagree.
      const resolveMember = createMemberResolver(committeeData?.legislators);
      const memberMap = new Map<string, {
        name: string; chamber: string; party: string | undefined;
        trades: Array<{ trade: FMPTrade; party: string | undefined }>;
      }>();

      for (const item of allPartyTrades) {
        const identity = resolveMember(item.trade);
        if (!identity) continue;
        if (!memberMap.has(identity.key)) {
          const chamber = identity.chamber ?? (report.scoredTrades.find(
            (t) => resolveMember(t.trade)?.key === identity.key
          )?.chamber === "senate" ? "Sen." : "Rep.");
          memberMap.set(identity.key, { name: identity.name, chamber, party: item.party, trades: [] });
        }
        memberMap.get(identity.key)!.trades.push(item);
      }

      const memberPageFiles = new Set<string>();
      let memberCount = 0;
      for (const [key, member] of memberMap) {
        const memberFile = `member-${key}.html`;
        memberPageFiles.add(memberFile);
        const memberHtml = buildMemberPage({
          memberName: member.name,
          chamber: member.chamber,
          party: member.party,
          trades: member.trades.sort((a, b) =>
            (b.trade.transactionDate ?? "").localeCompare(a.trade.transactionDate ?? "")
          ),
          dateLabel: runDateLabel,
          memberSlug: key,
          reportUrl: reportFile,
          indexUrl: "../archive.html",
          exchangeMap,
          scoreLookup,
          dateStr,
        });
        await fs.writeFile(path.join(dateDir, memberFile), memberHtml, "utf-8");
        memberCount++;
      }
      console.log(`   Members → ${memberCount} pages generated`);

      const memberLink: MemberLinker = (trade) => {
        const identity = resolveMember(trade);
        const file = identity ? `member-${identity.key}.html` : null;
        return file && memberPageFiles.has(file) ? file : null;
      };

      // ── Party pages ──────────────────────────────────────────────────────
      const partyGroups: Array<{ key: string; label: string; file: string }> = [
        { key: "r", label: "Republican", file: "party-republican.html" },
        { key: "d", label: "Democrat", file: "party-democrat.html" },
        { key: "i", label: "Independent", file: "party-independent.html" },
      ];

      const partyPageUrls: { republican?: string; democrat?: string; independent?: string } = {};
      for (const pg of partyGroups) {
        const filtered = allPartyTrades.filter(({ party }) => {
          const p = (party ?? "").toLowerCase();
          if (pg.key === "r") return p.startsWith("r");
          if (pg.key === "d") return p.startsWith("d");
          return p && !p.startsWith("r") && !p.startsWith("d");
        });
        if (!filtered.length) continue;
        const partyHtml = buildPartyPage({
          partyLabel: pg.label,
          trades: filtered,
          dateLabel: runDateLabel,
          reportUrl: reportFile,
          indexUrl: "../archive.html",
          exchangeMap,
          memberLink,
          scoreLookup,
          dateStr,
        });
        await fs.writeFile(path.join(dateDir, pg.file), partyHtml, "utf-8");
        console.log(`   ${pg.label} → ${pg.file} (${filtered.length} trades)`);
        if (pg.key === "r") partyPageUrls.republican = pg.file;
        if (pg.key === "d") partyPageUrls.democrat = pg.file;
        if (pg.key === "i") partyPageUrls.independent = pg.file;
      }

      // ── Generate report HTML ─────────────────────────────────────────────
      // The picker and chart list every run including this one, which is not
      // in the manifest until after the report is written.
      const runs = [
        { date: dateStr, label: runDateLabel, file: reportRelPath, newTrades: hasPrevious ? newlyDisclosed.length : undefined },
        ...priorManifest.filter((e) => e.date !== dateStr).map((e) => ({ date: e.date, label: e.dateLabel, file: e.file, newTrades: e.newTrades })),
      ]
        .sort((a, b) => b.date.localeCompare(a.date))
        .map((r) => ({ date: r.date, label: r.label, href: `../${r.file}`, newTrades: r.newTrades }));
      const previousRun = hasPrevious
        ? priorManifest.filter((e) => e.date < dateStr).sort((a, b) => b.date.localeCompare(a.date))[0]
        : undefined;
      const previousRunLabel = previousRun?.dateLabel;

      const html = buildHtmlReport({
        report,
        salesTrades,
        purchaseTrades,
        dateLabel: runDateLabel,
        indexUrl: "../archive.html",
        exchangeMap,
        partyPageUrls,
        memberLink,
        dateStr,
        topWindowDays,
        isNewlyDisclosed,
        previousRunLabel,
        runs,
        attention,
      });

      await fs.writeFile(path.join(dateDir, reportFile), html, "utf-8");
      console.log(`   Saved → ${path.join(dateDir, reportFile)}`);

      // ── Brief for agents ─────────────────────────────────────────────────
      const brief = JSON.stringify(buildBrief({
        report,
        trades: allTrades,
        isNewlyDisclosed,
        hasPrevious,
        filingBaseline,
        foundAfter,
        previousReport: previousRun && { date: previousRun.date, label: previousRun.dateLabel },
        reportDate: dateStr,
        reportLabel: runDateLabel,
        resolveParty,
        memberLink,
        topWindowDays,
        attention,
      }), null, 2);
      await fs.writeFile(path.join(dateDir, "brief.json"), brief, "utf-8");
      await fs.writeFile(path.join(webDir, "latest.json"), brief, "utf-8");
      console.log(`   Brief → ${path.join(dateDir, "brief.json")} and latest.json`);

      // ── Update manifest + rebuild index ──────────────────────────────────
      const manifest = await upsertManifest(webDir, {
        date: dateStr,
        dateLabel: runDateLabel,
        file: reportRelPath,
        totalTrades: report.totalTradesAnalyzed,
        topSymbols,
        newSymbols,
        newTrades: newlyDisclosed.length,
        ...(runMaxFiling ? { maxFilingDate: runMaxFiling } : {}),
        ranAt,
      });

      await writeIndexPages(webDir, manifest);
      console.log(`   Archive → ${path.join(webDir, "archive.html")} (${manifest.length} report${manifest.length !== 1 ? "s" : ""}); index.html opens the latest`);

      // ── Publish to S3 ────────────────────────────────────────────────────
      if (options.publish) {
        console.log("\n🚀 Publishing to S3...");
        await publishOutput({
          localDir: webDir,
          bucket: options.bucket as string | undefined,
          region: options.region as string | undefined,
          prefix: options.prefix as string | undefined,
        });
      } else {
        console.log(
          "\nTip: add --publish to sync to S3, or run:\n" +
          "  outlier-caucus report:html --publish --bucket <your-bucket>"
        );
      }

      if (attention.length) {
        console.log(`\n⚠️  ${attention.length} thing${attention.length === 1 ? "" : "s"} to look into (also listed at the foot of the report and in latest.json):`);
        for (const item of attention.slice(0, 10)) {
          console.log(`  • ${item.title}${item.inThisReport ? " [in this report]" : ""}`);
          for (const step of item.fix) console.log(`      ${step}`);
        }
        if (attention.length > 10) console.log(`  … ${attention.length - 10} more`);
      }

      console.log("\n✅ Done.");
    } catch (error) {
      console.error("❌ report:html failed:", error);
      process.exit(1);
    }
  });
