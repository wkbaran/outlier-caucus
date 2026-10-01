/**
 * Analysis Service
 *
 * Orchestrates the scoring of congressional trades using the modular
 * scoring and data provider components.
 */

import type { FMPTrade, CommitteeData, LegislatorPartyMap } from "../types/index.js";
import type {
  TradeInput,
  TraderInput,
  TraderHistory,
  MarketData,
  UniquenessResult,
  ScoringConfig,
} from "../scoring/types.js";
import { scoreTrade, scoreDerivative, scoreOwnership, DEFAULT_SCORING_CONFIG } from "../scoring/index.js";
import type { MarketDataProvider } from "../data/types.js";
import { CongressionalPatternAnalyzer } from "../data/pattern-analyzer.js";
import { createSectorMap } from "../data/sector-map.js";
import {
  findMemberByName,
  getMemberCommittees,
  getMemberParty,
  buildPartyMap,
} from "./committee-service.js";
import { saveReport } from "../utils/storage.js";
import { groupBy, tradeGroupKey } from "./trade-groups.js";

// ============================================
// Types for analysis results
// ============================================

export interface AnalyzedTrade {
  trade: FMPTrade;
  chamber: "senate" | "house";
  trader: TraderInput;
  score: UniquenessResult;
  /**
   * Set when this trade was scored together with others by the same member in
   * the same stock (see trade-groups.ts); the score is the group's. Absent for
   * a trade scored on its own.
   */
  groupId?: string;
}

export interface AnalysisReport {
  generatedAt: string;
  config: ScoringConfig;
  totalTradesAnalyzed: number;
  scoredTrades: AnalyzedTrade[];
  summary: {
    topByScore: AnalyzedTrade[];
    byRarity: AnalyzedTrade[];
    byCommitteeRelevance: AnalyzedTrade[];
    symbolStats: {
      totalSymbols: number;
      uniqueSymbols: number;
      rareSymbols: number;
    };
  };
}

// ============================================
// Trade conversion helpers
// ============================================

/**
 * Parse FMP amount string to numeric range
 */
function parseAmountRange(
  amount: string | undefined
): { low: number; high: number } | null {
  if (!amount) return null;

  const cleaned = amount.replace(/[$,]/g, "");
  const numbers = cleaned.match(/(\d+)/g);

  if (!numbers || numbers.length === 0) return null;

  if (numbers.length === 1) {
    const value = parseInt(numbers[0], 10);
    return { low: value, high: value };
  }

  return {
    low: parseInt(numbers[0], 10),
    high: parseInt(numbers[1], 10),
  };
}

/**
 * Convert FMP trade to TradeInput
 */
function toTradeInput(trade: FMPTrade): TradeInput {
  return {
    symbol: trade.symbol || null,
    assetDescription: trade.assetDescription || null,
    assetType: trade.assetType || null,
    type: trade.type || null,
    amount: parseAmountRange(trade.amount),
    transactionDate: trade.transactionDate || null,
    owner: trade.owner || null,
  };
}

/**
 * One TradeInput standing for a group of trades: amounts added up, and the
 * asset type and owner that score highest, so a group made through a spouse's
 * account or with options reads that way.
 */
function combineTradeInputs(trades: FMPTrade[]): TradeInput {
  const inputs = trades.map(toTradeInput);
  if (inputs.length === 1) return inputs[0];
  const amounts = inputs.map((i) => i.amount).filter((a): a is { low: number; high: number } => a !== null);
  const highest = (score: (t: TradeInput) => number) =>
    inputs.reduce((best, t) => (score(t) > score(best) ? t : best));
  return {
    ...inputs[0],
    amount: amounts.length
      ? { low: amounts.reduce((n, a) => n + a.low, 0), high: amounts.reduce((n, a) => n + a.high, 0) }
      : null,
    assetType: highest(scoreDerivative).assetType,
    owner: highest(scoreOwnership).owner,
  };
}

/**
 * Strip middle initials (e.g. "David J." -> "david") so a member whose disclosure
 * forms inconsistently include a middle initial still groups into one trader
 * history — otherwise their trade history/conviction scoring silently fragments
 * across "david-taylor" and "david-j.-taylor" buckets.
 */
export function normalizeFirstName(first: string): string {
  const parts = first
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter((part) => !/^[a-z]\.?$/.test(part));
  return parts.length > 0 ? parts.join(" ") : first.toLowerCase().trim();
}

/**
 * Create trader ID from trade
 */
function getTraderId(trade: FMPTrade, chamber: "senate" | "house"): string {
  const first = normalizeFirstName(trade.firstName || "");
  const last = (trade.lastName || "").toLowerCase().trim();
  return `${chamber}-${first}-${last}`;
}

// ============================================
// Main analysis function
// ============================================

export async function analyzeTrades(
  senateTrades: FMPTrade[],
  houseTrades: FMPTrade[],
  committeeData: CommitteeData | null,
  marketDataProvider: MarketDataProvider | null,
  config: ScoringConfig = DEFAULT_SCORING_CONFIG
): Promise<AnalysisReport> {
  const report = await buildAnalysis(senateTrades, houseTrades, committeeData, marketDataProvider, config);
  const reportPath = await saveReport("unique-trades", report);
  console.log(`\nReport saved to ${reportPath}`);
  return report;
}

/** Score every trade, without saving the result. */
export async function buildAnalysis(
  senateTrades: FMPTrade[],
  houseTrades: FMPTrade[],
  committeeData: CommitteeData | null,
  marketDataProvider: MarketDataProvider | null,
  config: ScoringConfig = DEFAULT_SCORING_CONFIG
): Promise<AnalysisReport> {
  const allTrades = [
    ...senateTrades.map((t) => ({ trade: t, chamber: "senate" as const })),
    ...houseTrades.map((t) => ({ trade: t, chamber: "house" as const })),
  ];

  console.log(`Analyzing ${allTrades.length} total trades...`);

  // A member's lots in one stock on one side, close together, count as one
  // trade everywhere below: in their usual trade size, in how often Congress
  // trades the stock, and in the score.
  const maxGapDays = config.grouping?.maxGapDays ?? 0;
  const groups = groupBy(
    allTrades,
    ({ trade, chamber }) => tradeGroupKey(getTraderId(trade, chamber), trade),
    ({ trade }) => trade.transactionDate,
    maxGapDays
  );
  const grouped = groups.filter((g) => g.length > 1);
  console.log(
    `  Grouped ${grouped.reduce((n, g) => n + g.length, 0)} trades into ${grouped.length} groups ` +
    `(same member, stock and side, ${maxGapDays === 0 ? "same day" : `at most ${maxGapDays} days apart`})`
  );

  // Build trading pattern analyzer, counting each group once
  const patternAnalyzer = new CongressionalPatternAnalyzer(groups.map((g) => g[0].trade));
  const patternStats = patternAnalyzer.getStats();
  console.log(
    `  Symbol stats: ${patternStats.uniqueSymbols} unique, ${patternStats.rareSymbols} rare, ${patternStats.commonSymbols} common`
  );

  // Build sector map (uses FMP sector/industry taxonomy)
  const sectorMap = createSectorMap();

  // Build party map from legislators data
  const partyMap: LegislatorPartyMap | null = committeeData?.legislators
    ? buildPartyMap(committeeData.legislators)
    : null;

  // Build trader histories
  const traderHistories = buildTraderHistories(groups);
  console.log(`  Built histories for ${traderHistories.size} traders`);

  // Get unique symbols for market data fetch
  const symbols = [
    ...new Set(
      allTrades
        .map((t) => t.trade.symbol)
        .filter((s): s is string => !!s && s.length > 0)
    ),
  ];

  // Fetch market data if provider available
  let marketDataMap = new Map<string, MarketData>();
  if (marketDataProvider) {
    console.log(`  Fetching market data from ${marketDataProvider.getName()}...`);
    marketDataMap = await marketDataProvider.getMarketDataBatch(symbols);
  } else {
    console.log(`  No market data provider - skipping market cap scoring`);
  }

  // Score each trade
  console.log(`  Scoring trades...`);
  const scoredTrades: AnalyzedTrade[] = [];

  for (const group of groups) {
    const { trade, chamber } = group[0];
    const traderId = getTraderId(trade, chamber);
    const traderHistory = traderHistories.get(traderId);

    if (!traderHistory) continue;

    // Build trader info
    const trader = buildTraderInput(trade, chamber, committeeData, partyMap);

    // Get market data
    const marketData = trade.symbol
      ? marketDataMap.get(trade.symbol) || null
      : null;

    // Get trading pattern
    const pattern = trade.symbol
      ? patternAnalyzer.getPattern(trade.symbol)
      : null;

    // Score the trade
    const score = scoreTrade(
      combineTradeInputs(group.map((g) => g.trade)),
      trader,
      traderHistory,
      marketData,
      pattern,
      sectorMap,
      config
    );

    const groupId = group.length > 1
      ? `${tradeGroupKey(traderId, trade)}|${trade.transactionDate}`
      : undefined;
    for (const member of group) {
      scoredTrades.push({
        trade: member.trade,
        chamber,
        trader,
        score,
        ...(groupId ? { groupId } : {}),
      });
    }
  }

  // Sort by date descending (most recent first)
  scoredTrades.sort((a, b) => {
    const dateA = a.trade.transactionDate || "";
    const dateB = b.trade.transactionDate || "";
    return dateB.localeCompare(dateA);
  });

  // Build summary
  const topByScore = scoredTrades.slice(0, 20);

  const byRarity = [...scoredTrades]
    .filter((t) => t.score.flags.isRareStock)
    .sort((a, b) => b.score.factors.rarityScore - a.score.factors.rarityScore)
    .slice(0, 20);

  const byCommitteeRelevance = [...scoredTrades]
    .filter((t) => t.score.flags.hasCommitteeRelevance)
    .sort(
      (a, b) =>
        b.score.factors.committeeRelevanceScore -
        a.score.factors.committeeRelevanceScore
    )
    .slice(0, 20);

  const report: AnalysisReport = {
    generatedAt: new Date().toISOString(),
    config,
    totalTradesAnalyzed: allTrades.length,
    scoredTrades,
    summary: {
      topByScore,
      byRarity,
      byCommitteeRelevance,
      symbolStats: patternStats,
    },
  };

  return report;
}

// ============================================
// Helper functions
// ============================================

/**
 * Each member's history, with a group of trades counted as one trade of their
 * combined size. Averaging single lots instead would make a member who always
 * buys in several lots look like they always trade far above their usual size.
 */
function buildTraderHistories(
  groups: { trade: FMPTrade; chamber: "senate" | "house" }[][]
): Map<string, TraderHistory> {
  const histories = new Map<string, TraderHistory>();

  // Group trades by trader
  const traderTrades = new Map<string, TradeInput[]>();

  for (const group of groups) {
    const { trade, chamber } = group[0];
    const traderId = getTraderId(trade, chamber);

    if (!traderTrades.has(traderId)) {
      traderTrades.set(traderId, []);
    }
    traderTrades.get(traderId)!.push(combineTradeInputs(group.map((g) => g.trade)));
  }

  // Build histories
  for (const [traderId, tradeInputs] of traderTrades) {
    const amounts = tradeInputs
      .map((t) => (t.amount ? (t.amount.low + t.amount.high) / 2 : null))
      .filter((a): a is number => a !== null);

    const averageTradeSize =
      amounts.length > 0
        ? amounts.reduce((a, b) => a + b, 0) / amounts.length
        : null;

    histories.set(traderId, {
      visibleTrades: tradeInputs,
      averageTradeSize,
      totalTradeCount: tradeInputs.length,
    });
  }

  return histories;
}

function buildTraderInput(
  trade: FMPTrade,
  chamber: "senate" | "house",
  committeeData: CommitteeData | null,
  partyMap: LegislatorPartyMap | null
): TraderInput {
  const traderId = getTraderId(trade, chamber);

  // Find committees and party
  let committees: string[] = [];
  let party: string | undefined;
  if (committeeData && trade.firstName && trade.lastName) {
    const bioguideId = findMemberByName(
      trade.firstName,
      trade.lastName,
      committeeData.membership,
      committeeData.legislators
    );
    if (bioguideId) {
      committees = getMemberCommittees(bioguideId, committeeData.membership);
      party = getMemberParty(bioguideId, partyMap);
    }
  }

  return {
    id: traderId,
    firstName: trade.firstName || "",
    lastName: trade.lastName || "",
    chamber,
    committees,
    party,
  };
}

/**
 * Get committee name from ID
 */
function getCommitteeName(
  committeeId: string,
  committeeData: CommitteeData | null
): string | null {
  if (!committeeData) return null;

  const committee = committeeData.committees.find(
    (c) => c.thomas_id === committeeId ||
           c.house_committee_id === committeeId ||
           c.senate_committee_id === committeeId
  );

  return committee?.name || null;
}

/**
 * Get committee names from IDs (exported for use in report formatting)
 */
export function getCommitteeNames(
  committeeIds: string[],
  committeeData: CommitteeData | null
): string[] {
  return committeeIds
    .map((id) => getCommitteeName(id, committeeData))
    .filter((name): name is string => name !== null);
}

// ============================================
// Report formatting
// ============================================

export function formatTradeReport(analyzed: AnalyzedTrade, committeeData?: CommitteeData | null): string {
  const { trade, chamber, trader, score } = analyzed;

  // Format party as (R), (D), or empty
  const partyLabel = trader.party
    ? ` (${trader.party === "Republican" ? "R" : trader.party === "Democrat" ? "D" : trader.party.charAt(0)})`
    : "";

  const lines = [
    `📊 ${trade.symbol || "N/A"} - ${trade.assetDescription || "Unknown"}`,
    `   Trader: ${trade.firstName} ${trade.lastName}${partyLabel} (${chamber})`,
    `   Type: ${trade.type || "N/A"} | Amount: ${trade.amount || "N/A"}`,
    `   Date: ${trade.transactionDate || "N/A"}`,
    `   Score: ${score.overallScore}/100`,
    `   Factors:`,
  ];

  // Market cap
  if (score.explanation.marketCap) {
    const cap = score.explanation.marketCap;
    lines.push(
      `     - Market Cap: $${(cap.value / 1_000_000).toFixed(0)}M (${cap.category})`
    );
  }

  // Conviction
  if (score.explanation.conviction && score.flags.isHighConviction) {
    const conv = score.explanation.conviction;
    lines.push(
      `     - High Conviction: ${conv.multiplier.toFixed(1)}x typical trade`
    );
  }

  // Rarity
  if (score.explanation.rarity) {
    const rarity = score.explanation.rarity;
    lines.push(
      `     - Rarity: ${rarity.category} (${rarity.totalCongressTrades} total congress trades)`
    );
  }

  // Committee relevance
  if (score.flags.hasCommitteeRelevance && score.explanation.committeeRelevance) {
    const rel = score.explanation.committeeRelevance;

    // Get the actual committee names from IDs
    const relevantCommitteeNames = getCommitteeNames(rel.overlappingCommittees, committeeData || null);

    // Build the display
    const committeesDisplay = relevantCommitteeNames.length > 0
      ? relevantCommitteeNames.join(", ")
      : rel.overlappingCommittees.join(", ");

    lines.push(`     ⚠️  Committee Relevance: ${committeesDisplay}`);

    // Add sector/industry info
    const sectorParts: string[] = [];
    if (rel.stockSector) sectorParts.push(`Sector: ${rel.stockSector}`);
    if (rel.stockIndustry) sectorParts.push(`Industry: ${rel.stockIndustry}`);
    if (sectorParts.length > 0) {
      lines.push(`        ${sectorParts.join(" | ")}`);
    }
  }

  // Derivative
  if (score.flags.isDerivative && score.explanation.derivative) {
    lines.push(
      `     - Derivative: ${score.explanation.derivative.assetType}`
    );
  }

  // Ownership
  if (score.flags.isIndirectOwnership && score.explanation.ownership) {
    lines.push(
      `     - Indirect Ownership: ${score.explanation.ownership.owner}`
    );
  }

  return lines.join("\n");
}
