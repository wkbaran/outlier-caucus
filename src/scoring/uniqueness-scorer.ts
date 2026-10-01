/**
 * Uniqueness Scorer
 *
 * Pure scoring logic - no I/O, no side effects.
 * Takes trade data and context, returns scores.
 */

import type {
  TradeInput,
  TraderInput,
  TraderHistory,
  MarketData,
  CongressionalTradingPattern,
  CommitteeSectorMap,
  FactorScores,
  ScoreExplanation,
  UniquenessResult,
  ScoringConfig,
} from "./types.js";
import { DEFAULT_SCORING_CONFIG } from "./types.js";

/**
 * Score a single trade for uniqueness
 */
export function scoreTrade(
  trade: TradeInput,
  trader: TraderInput,
  traderHistory: TraderHistory,
  marketData: MarketData | null,
  tradingPattern: CongressionalTradingPattern | null,
  sectorMap: CommitteeSectorMap | null,
  config: ScoringConfig = DEFAULT_SCORING_CONFIG
): UniquenessResult {
  const factors: FactorScores = {
    marketCapScore: scoreMarketCap(marketData, config),
    convictionScore: scoreConviction(trade, traderHistory, config),
    rarityScore: scoreRarity(tradingPattern, config),
    committeeRelevanceScore: scoreCommitteeRelevance(trader, marketData, sectorMap),
    derivativeScore: scoreDerivative(trade),
    ownershipScore: scoreOwnership(trade),
  };

  const explanation = buildExplanation(
    trade,
    trader,
    traderHistory,
    marketData,
    tradingPattern,
    sectorMap,
    config
  );

  const flags = {
    isSmallCap: factors.marketCapScore >= 50,
    isHighConviction: factors.convictionScore >= 50,
    isRareStock: factors.rarityScore >= 50,
    hasCommitteeRelevance: factors.committeeRelevanceScore >= 50,
    isDerivative: factors.derivativeScore >= 50,
    isIndirectOwnership: factors.ownershipScore >= 50,
  };

  const overallScore = calculateOverallScore(factors, config);

  return {
    overallScore,
    factors,
    explanation,
    flags,
  };
}

/**
 * Calculate overall score from weighted factors
 */
function calculateOverallScore(
  factors: FactorScores,
  config: ScoringConfig
): number {
  const weighted =
    factors.marketCapScore * config.weights.marketCap +
    factors.convictionScore * config.weights.conviction +
    factors.rarityScore * config.weights.rarity +
    factors.committeeRelevanceScore * config.weights.committeeRelevance +
    factors.derivativeScore * config.weights.derivative +
    factors.ownershipScore * config.weights.ownership;

  return Math.round(weighted);
}

// ============================================
// Individual Factor Scoring Functions
// ============================================

/**
 * Score based on market cap - smaller = higher score
 */
function scoreMarketCap(
  marketData: MarketData | null,
  config: ScoringConfig
): number {
  if (!marketData?.marketCap) {
    return 0; // No data = no score (not penalized, just not scored)
  }

  const cap = marketData.marketCap;

  if (cap < config.marketCap.micro) {
    return 100; // Micro cap
  } else if (cap < config.marketCap.small) {
    return 75; // Small cap
  } else if (cap < config.marketCap.mid) {
    return 25; // Mid cap
  } else {
    return 0; // Large cap
  }
}

/**
 * Score based on conviction - larger trade relative to typical = higher score
 */
function scoreConviction(
  trade: TradeInput,
  traderHistory: TraderHistory,
  config: ScoringConfig
): number {
  if (!trade.amount || !traderHistory.averageTradeSize) {
    return 0;
  }

  // Use midpoint of trade range
  const tradeSize = (trade.amount.low + trade.amount.high) / 2;
  const multiplier = tradeSize / traderHistory.averageTradeSize;

  if (multiplier >= config.conviction.veryHigh) {
    return 100;
  } else if (multiplier >= config.conviction.high) {
    return 75;
  } else if (multiplier >= 1.5) {
    return 50;
  } else if (multiplier >= 1) {
    return 25;
  } else {
    return 0; // Below average trade
  }
}

/**
 * Score based on rarity - less frequently traded by congress = higher score
 */
function scoreRarity(
  pattern: CongressionalTradingPattern | null,
  config: ScoringConfig
): number {
  if (!pattern) {
    return 50; // Unknown = moderate score (could be unique)
  }

  const { totalTrades, uniqueTraders } = pattern;

  // Score based on total trades
  let tradeScore: number;
  if (totalTrades <= config.rarity.unique) {
    tradeScore = 100;
  } else if (totalTrades <= config.rarity.rare) {
    tradeScore = 75;
  } else if (totalTrades <= config.rarity.uncommon) {
    tradeScore = 50;
  } else {
    tradeScore = 0;
  }

  // Bonus if few unique traders (concentrated interest)
  let traderBonus = 0;
  if (uniqueTraders === 1) {
    traderBonus = 25; // Only one person trades this
  } else if (uniqueTraders <= 3) {
    traderBonus = 10;
  }

  return Math.min(100, tradeScore + traderBonus);
}

/**
 * Score based on committee relevance - trading in sectors you regulate = higher score
 * Uses FMP sector/industry data from MarketData
 *
 * Weights each overlapping committee by specificity rather than just counting
 * committees. A committee whose entire jurisdiction is one sector (e.g. Transportation
 * and Infrastructure -> Industrials) is a far more direct conflict-of-interest signal
 * than a committee that happens to list the stock's sector among several unrelated
 * ones (e.g. Judiciary -> Technology, Communication Services) — so two overlaps from
 * broad committees no longer automatically outrank one overlap from a narrow one.
 * A match on the stock's specific FMP industry (not just its broad sector) is treated
 * as maximally specific, since the committee's jurisdiction named that exact industry.
 */
function scoreCommitteeRelevance(
  trader: TraderInput,
  marketData: MarketData | null,
  sectorMap: CommitteeSectorMap | null
): number {
  if (!sectorMap || trader.committees.length === 0) {
    return 0;
  }

  const sector = marketData?.sector ?? null;
  const industry = marketData?.industry ?? null;

  // If we don't have sector/industry data, can't score
  if (!sector && !industry) {
    return 0;
  }

  let relevanceWeight = 0;
  for (const committeeId of trader.committees) {
    const committeeSectors = sectorMap.getCommitteeSectors(committeeId);
    const committeeIndustries = sectorMap.getCommitteeIndustries(committeeId);
    const industryMatch = !!industry && committeeIndustries.includes(industry);
    const sectorMatch = !!sector && committeeSectors.includes(sector);

    if (industryMatch) {
      relevanceWeight += 1;
    } else if (sectorMatch) {
      relevanceWeight += 1 / Math.max(1, committeeSectors.length);
    }
  }

  if (relevanceWeight <= 0) {
    return 0;
  } else if (relevanceWeight >= 1) {
    return 100; // A full committee's worth of specific, targeted overlap
  } else {
    return 75; // Some relevance, but diluted across a broader committee mandate
  }
}

/**
 * Score based on asset type - derivatives indicate timing sensitivity
 */
export function scoreDerivative(trade: TradeInput): number {
  if (!trade.assetType) {
    return 0;
  }

  const assetType = trade.assetType.toLowerCase();

  if (
    assetType.includes("option") ||
    assetType.includes("warrant") ||
    assetType.includes("right")
  ) {
    return 100; // Options/warrants are timing-sensitive
  } else if (
    assetType.includes("future") ||
    assetType.includes("derivative")
  ) {
    return 75;
  } else {
    return 0; // Regular stock
  }
}

/**
 * Score based on ownership - indirect ownership may indicate distancing
 */
export function scoreOwnership(trade: TradeInput): number {
  if (!trade.owner) {
    return 0;
  }

  const owner = trade.owner.toLowerCase().trim();

  // House PTRs frequently abbreviate the owner field (SP/JT/DC) instead of
  // spelling it out the way Senate eFD filings do (Spouse/Joint/Dependent).
  if (owner.includes("spouse") || owner === "sp") {
    return 75; // Spouse trades
  } else if (owner.includes("child") || owner.includes("dependent") || owner === "dc") {
    return 100; // Child/dependent trades
  } else if (owner.includes("joint") || owner === "jt") {
    return 25; // Joint ownership
  } else {
    return 0; // Self
  }
}

// ============================================
// Explanation Builder
// ============================================

function buildExplanation(
  trade: TradeInput,
  trader: TraderInput,
  traderHistory: TraderHistory,
  marketData: MarketData | null,
  tradingPattern: CongressionalTradingPattern | null,
  sectorMap: CommitteeSectorMap | null,
  config: ScoringConfig
): ScoreExplanation {
  const explanation: ScoreExplanation = {};

  // Market cap explanation
  if (marketData?.marketCap) {
    const cap = marketData.marketCap;
    let category: "micro" | "small" | "mid" | "large";
    if (cap < config.marketCap.micro) {
      category = "micro";
    } else if (cap < config.marketCap.small) {
      category = "small";
    } else if (cap < config.marketCap.mid) {
      category = "mid";
    } else {
      category = "large";
    }
    explanation.marketCap = { value: cap, category };
  }

  // Conviction explanation
  if (trade.amount && traderHistory.averageTradeSize) {
    const tradeSize = (trade.amount.low + trade.amount.high) / 2;
    explanation.conviction = {
      tradeSize,
      averageSize: traderHistory.averageTradeSize,
      multiplier: tradeSize / traderHistory.averageTradeSize,
    };
  }

  // Rarity explanation
  if (tradingPattern) {
    let category: "unique" | "rare" | "uncommon" | "common";
    if (tradingPattern.totalTrades <= config.rarity.unique) {
      category = "unique";
    } else if (tradingPattern.totalTrades <= config.rarity.rare) {
      category = "rare";
    } else if (tradingPattern.totalTrades <= config.rarity.uncommon) {
      category = "uncommon";
    } else {
      category = "common";
    }
    explanation.rarity = {
      totalCongressTrades: tradingPattern.totalTrades,
      uniqueTraders: tradingPattern.uniqueTraders,
      category,
    };
  }

  // Committee relevance explanation
  if (sectorMap && trader.committees.length > 0) {
    const sector = marketData?.sector ?? null;
    const industry = marketData?.industry ?? null;

    const overlappingCommittees: string[] = [];
    for (const committeeId of trader.committees) {
      if (sectorMap.hasOverlap(committeeId, sector, industry)) {
        overlappingCommittees.push(committeeId);
      }
    }

    if (overlappingCommittees.length > 0) {
      explanation.committeeRelevance = {
        traderCommittees: trader.committees,
        stockSector: sector,
        stockIndustry: industry,
        overlappingCommittees,
      };
    }
  }

  // Derivative explanation
  if (trade.assetType) {
    const isDerivative =
      trade.assetType.toLowerCase().includes("option") ||
      trade.assetType.toLowerCase().includes("warrant");
    explanation.derivative = {
      assetType: trade.assetType,
      isDerivative,
    };
  }

  // Ownership explanation
  if (trade.owner) {
    const isIndirect =
      trade.owner.toLowerCase() !== "self" &&
      !trade.owner.toLowerCase().includes("self");
    explanation.ownership = {
      owner: trade.owner,
      isIndirect,
    };
  }

  return explanation;
}

// ============================================
// Batch Scoring Utilities
// ============================================

export interface BatchScoreInput {
  trade: TradeInput;
  trader: TraderInput;
  traderHistory: TraderHistory;
  marketData: MarketData | null;
  tradingPattern: CongressionalTradingPattern | null;
}

/**
 * Score multiple trades
 */
export function scoreTrades(
  inputs: BatchScoreInput[],
  sectorMap: CommitteeSectorMap | null,
  config: ScoringConfig = DEFAULT_SCORING_CONFIG
): UniquenessResult[] {
  return inputs.map((input) =>
    scoreTrade(
      input.trade,
      input.trader,
      input.traderHistory,
      input.marketData,
      input.tradingPattern,
      sectorMap,
      config
    )
  );
}

/**
 * Filter and sort scored trades by overall score
 */
export function filterTopScores(
  results: { trade: TradeInput; score: UniquenessResult }[],
  minScore: number = 50,
  limit: number = 50
): { trade: TradeInput; score: UniquenessResult }[] {
  return results
    .filter((r) => r.score.overallScore >= minScore)
    .sort((a, b) => b.score.overallScore - a.score.overallScore)
    .slice(0, limit);
}
