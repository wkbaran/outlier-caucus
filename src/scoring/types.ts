/**
 * Scoring Module Types
 *
 * These types define the inputs and outputs for the uniqueness scoring algorithm.
 * The scoring module is pure - it takes data and returns scores without any I/O.
 */

// ============================================
// Input Types - What the scorer needs
// ============================================

/**
 * A trade to be scored
 */
export interface TradeInput {
  symbol: string | null;
  assetDescription: string | null;
  assetType: string | null; // e.g., "Stock", "Stock Option", etc.
  type: string | null; // "purchase", "sale", etc.
  amount: { low: number; high: number } | null;
  transactionDate: string | null;
  owner: string | null; // "Self", "Spouse", "Child", "Joint"
}

/**
 * Information about the trader
 */
export interface TraderInput {
  id: string;
  firstName: string;
  lastName: string;
  chamber: "senate" | "house";
  committees: string[]; // Committee IDs
  party?: string; // "Republican", "Democrat", etc.
}

/**
 * Historical context for a trader
 */
export interface TraderHistory {
visibleTrades: TradeInput[];
  averageTradeSize: number | null;
  totalTradeCount: number;
}

/**
 * Market data for a stock (optional - scoring works without it)
 */
export interface MarketData {
  marketCap: number | null;
  sector: string | null;
  industry: string | null;
  averageVolume: number | null;
  /** Exchange short name from FMP (e.g. "NASDAQ", "NYSE", "AMEX") */
  exchange?: string | null;
}

/**
 * Congressional trading patterns for a stock
 */
export interface CongressionalTradingPattern {
  symbol: string;
  totalTrades: number; // How many times has congress traded this?
  uniqueTraders: number; // How many different members have traded it?
  recentTrades: number; // Trades in last 90 days
}

/**
 * Committee sector mapping for relevance checking
 * Uses FMP sector/industry taxonomy
 */
export interface CommitteeSectorMap {
  /** Get FMP sectors a committee has jurisdiction over */
  getCommitteeSectors(committeeId: string): string[];
  /** Get FMP industries a committee has jurisdiction over */
  getCommitteeIndustries(committeeId: string): string[];
  /** Check if a committee has jurisdiction over a stock's sector/industry */
  hasOverlap(committeeId: string, sector: string | null, industry: string | null): boolean;
}

// ============================================
// Output Types - What the scorer produces
// ============================================

/**
 * Individual factor scores (0-100 scale each)
 */
export interface FactorScores {
  /** Small/micro cap stocks are less followed */
  marketCapScore: number;

  /** Large trade relative to trader's typical size */
  convictionScore: number;

  /** Stock rarely traded by congress */
  rarityScore: number;

  /** Trader sits on committee relevant to stock's sector */
  committeeRelevanceScore: number;

  /** Options/derivatives indicate timing sensitivity */
  derivativeScore: number;

  /** Spouse/family trades may indicate distancing */
  ownershipScore: number;
}

/**
 * Detailed breakdown of why a trade scored the way it did
 */
export interface ScoreExplanation {
  marketCap?: {
    value: number;
    category: "micro" | "small" | "mid" | "large" | "unknown";
  };
  conviction?: {
    tradeSize: number;
    averageSize: number;
    multiplier: number;
  };
  rarity?: {
    totalCongressTrades: number;
    uniqueTraders: number;
    category: "unique" | "rare" | "uncommon" | "common";
  };
  committeeRelevance?: {
    traderCommittees: string[];
    stockSector: string | null;
    stockIndustry: string | null;
    overlappingCommittees: string[];
  };
  derivative?: {
    assetType: string;
    isDerivative: boolean;
  };
  ownership?: {
    owner: string;
    isIndirect: boolean;
  };
}

/**
 * Complete score result for a trade
 */
export interface UniquenessResult {
  /** Overall score 0-100 */
  overallScore: number;

  /** Individual factor scores */
  factors: FactorScores;

  /** Human-readable explanation */
  explanation: ScoreExplanation;

  /** Flags for quick filtering */
  flags: {
    isSmallCap: boolean;
    isHighConviction: boolean;
    isRareStock: boolean;
    hasCommitteeRelevance: boolean;
    isDerivative: boolean;
    isIndirectOwnership: boolean;
  };
}

// ============================================
// Configuration
// ============================================

export interface ScoringConfig {
  /** Market cap thresholds in dollars */
  marketCap: {
    micro: number;  // Below this = micro cap
    small: number;  // Below this = small cap
    mid: number;    // Below this = mid cap
  };

  /** Conviction multiplier thresholds */
  conviction: {
    high: number;   // Trade is Nx typical = high conviction
    veryHigh: number;
  };

  /** Rarity thresholds (total congress trades) */
  rarity: {
    unique: number;   // Trades <= this = unique
    rare: number;     // Trades <= this = rare
    uncommon: number; // Trades <= this = uncommon
  };

  /** Weight of each factor in overall score (should sum to 1) */
  weights: {
    marketCap: number;
    conviction: number;
    rarity: number;
    committeeRelevance: number;
    derivative: number;
    ownership: number;
  };

  /**
   * A member's trades in one stock on the same side are scored and ranked as one
   * when each falls within this many days of the one before (0 = same day only).
   */
  grouping: {
    maxGapDays: number;
  };
}

export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  marketCap: {
    micro: 300_000_000,      // $300M
    small: 2_000_000_000,    // $2B
    mid: 10_000_000_000,     // $10B
  },
  conviction: {
    high: 2,      // 2x typical trade
    veryHigh: 5,  // 5x typical trade
  },
  rarity: {
    unique: 1,    // Only this trade
    rare: 3,      // 3 or fewer trades
    uncommon: 10, // 10 or fewer trades
  },
  weights: {
    marketCap: 0.20,
    conviction: 0.25,
    rarity: 0.25,
    committeeRelevance: 0.15,
    derivative: 0.10,
    ownership: 0.05,
  },
  grouping: {
    maxGapDays: 0,
  },
};
