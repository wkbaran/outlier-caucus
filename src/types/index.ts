import { z } from "zod";

// ============================================
// Committee Types (from congress-legislators)
// ============================================

export const CommitteeSchema = z.object({
  type: z.string(),
  name: z.string(),
  url: z.string().optional(),
  minority_url: z.string().optional(),
  thomas_id: z.string().optional(),
  house_committee_id: z.string().optional(),
  senate_committee_id: z.string().optional(),
  jurisdiction: z.string().optional(),
  jurisdiction_source: z.string().optional(),
  subcommittees: z
    .array(
      z.object({
        name: z.string(),
        thomas_id: z.string().optional(),
        address: z.string().optional(),
        phone: z.string().optional(),
      })
    )
    .optional(),
});

export type Committee = z.infer<typeof CommitteeSchema>;

export const CommitteesResponseSchema = z.array(CommitteeSchema);

// Committee membership from congress-legislators
export const CommitteeMemberSchema = z.object({
  name: z.string(),
  party: z.string().optional(),
  rank: z.number().optional(),
  title: z.string().optional(),
  bioguide: z.string().optional(),
});

export type CommitteeMember = z.infer<typeof CommitteeMemberSchema>;

// The membership file is keyed by committee thomas_id
export const CommitteeMembershipResponseSchema = z.record(
  z.array(CommitteeMemberSchema)
);

export type CommitteeMembershipResponse = z.infer<
  typeof CommitteeMembershipResponseSchema
>;

// ============================================
// Legislator Types (from congress-legislators)
// ============================================

export const LegislatorIdSchema = z.object({
  bioguide: z.string(),
  thomas: z.string().optional(),
  lis: z.string().optional(),
  govtrack: z.number().optional(),
  opensecrets: z.string().optional(),
  votesmart: z.number().optional(),
  fec: z.array(z.string()).optional(),
  cspan: z.number().optional(),
  wikipedia: z.string().optional(),
  house_history: z.number().optional(),
  ballotpedia: z.string().optional(),
  maplight: z.number().optional(),
  icpsr: z.number().optional(),
  wikidata: z.string().optional(),
  google_entity_id: z.string().optional(),
});

export const LegislatorNameSchema = z.object({
  first: z.string(),
  last: z.string(),
  middle: z.string().optional(),
  suffix: z.string().optional(),
  nickname: z.string().optional(),
  official_full: z.string().optional(),
});

export const LegislatorTermSchema = z.object({
  type: z.enum(["sen", "rep"]),
  start: z.string(),
  end: z.string(),
  state: z.string(),
  party: z.string(),
  class: z.number().optional(),
  district: z.number().optional(),
  state_rank: z.string().optional(),
  url: z.string().optional(),
  rss_url: z.string().optional(),
  contact_form: z.string().optional(),
  address: z.string().optional(),
  office: z.string().optional(),
  phone: z.string().optional(),
});

export const LegislatorSchema = z.object({
  id: LegislatorIdSchema,
  name: LegislatorNameSchema,
  bio: z.object({
    birthday: z.string().optional(),
    gender: z.string().optional(),
    religion: z.string().optional(),
  }).optional(),
  terms: z.array(LegislatorTermSchema),
});

export type Legislator = z.infer<typeof LegislatorSchema>;

export const LegislatorsResponseSchema = z.array(LegislatorSchema);

// ============================================
// Market Sector Types
// ============================================

export const MarketSector = z.enum([
  "Technology",
  "Healthcare",
  "Financials",
  "Energy",
  "Defense",
  "Industrials",
  "Consumer Discretionary",
  "Consumer Staples",
  "Materials",
  "Real Estate",
  "Utilities",
  "Telecommunications",
  "Transportation",
  "Agriculture",
  "Cybersecurity",
  "Cryptocurrency",
  "Pharmaceuticals",
  "Biotechnology",
  "Media",
  "Aerospace",
]);

export type MarketSector = z.infer<typeof MarketSector>;

export interface CommitteeSectorMapping {
  committeeId: string;
  committeeName: string;
  sectors: MarketSector[];
  keywords: string[];
}

// ============================================
// FMP Trade Types
// ============================================

export const FMPTradeSchema = z.object({
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  office: z.string().optional(),
  link: z.string().optional(),
  dateRecieved: z.string().optional(), // Note: FMP typo
  transactionDate: z.string().optional(),
  owner: z.string().optional(),
  assetDescription: z.string().optional(),
  assetType: z.string().optional(),
  type: z.string().optional(), // purchase, sale, etc
  amount: z.string().optional(),
  comment: z.string().optional(),
  symbol: z.string().optional(),
  // "ocr" when transcribed by a vision model from a scanned filing
  source: z.string().optional(),
  // ISO time this service first stored the trade; absent on trades stored before it was recorded
  firstSeen: z.string().optional(),
});

export type FMPTrade = z.infer<typeof FMPTradeSchema>;

export const FMPTradesResponseSchema = z.array(FMPTradeSchema);

// ============================================
// Stock Quote Types (for market cap, volume)
// ============================================

export const FMPQuoteSchema = z.object({
  symbol: z.string(),
  name: z.string().optional(),
  price: z.number().optional(),
  changesPercentage: z.number().optional(),
  change: z.number().optional(),
  dayLow: z.number().optional(),
  dayHigh: z.number().optional(),
  yearHigh: z.number().optional(),
  yearLow: z.number().optional(),
  marketCap: z.number().optional(),
  priceAvg50: z.number().optional(),
  priceAvg200: z.number().optional(),
  volume: z.number().optional(),
  avgVolume: z.number().optional(),
  exchange: z.string().optional(),
  open: z.number().optional(),
  previousClose: z.number().optional(),
  eps: z.number().optional(),
  pe: z.number().optional(),
  sharesOutstanding: z.number().optional(),
});

export type FMPQuote = z.infer<typeof FMPQuoteSchema>;

// ============================================
// Enriched Trade Types (our internal types)
// ============================================

export interface EnrichedTrade extends FMPTrade {
  congressMemberId: string;
  chamber: "senate" | "house";
  marketCap?: number;
  avgVolume?: number;
  currentPrice?: number;
  sectorExposure?: MarketSector[];
  amountLow?: number;
  amountHigh?: number;
}

export interface CongressMemberProfile {
  id: string;
  firstName: string;
  lastName: string;
  chamber: "senate" | "house";
  committees: string[];
  trades: EnrichedTrade[];
  averageTradeSize?: number;
  totalTrades: number;
}

// ============================================
// Uniqueness Score Types
// ============================================

export interface UniquenessScore {
  overall: number; // 0-100
  marketCapScore: number; // Higher for smaller cap
  volumeScore: number; // Higher for lower volume relative to avg
  convictionScore: number; // Higher for larger position relative to typical
  relativeVolumeScore: number; // Trade size vs stock's avg volume
  factors: UniquenessFactors;
}

export interface UniquenessFactors {
  isSmallCap: boolean;
  marketCap?: number;
  isBelowAvgVolume: boolean;
  avgVolume?: number;
  tradeVolume?: number;
  isHighConviction: boolean;
  tradeAmount?: { low: number; high: number };
  memberAvgTradeSize?: number;
  relativeToAvgVolume?: number;
}

export interface UniqueTradeReport {
  trade: EnrichedTrade;
  score: UniquenessScore;
  memberProfile?: CongressMemberProfile;
  committeeRelevance?: {
    committees: string[];
    sectors: MarketSector[];
    potentialInsight: boolean;
  };
}

// ============================================
// Storage Types
// ============================================

export interface StoredData<T> {
  fetchedAt: string;
  data: T;
}

export interface CommitteeData {
  committees: Committee[];
  membership: CommitteeMembershipResponse;
  sectorMappings: CommitteeSectorMapping[];
  legislators?: Legislator[];
}

// Lookup map: bioguide ID -> party name
export type LegislatorPartyMap = Map<string, string>;

export interface TradeData {
  senateTrades: FMPTrade[];
  houseTrades: FMPTrade[];
}

export interface AnalysisReport {
  generatedAt: string;
  totalTradesAnalyzed: number;
  uniqueTrades: UniqueTradeReport[];
  summary: {
    topByScore: UniqueTradeReport[];
    byMember: Record<string, UniqueTradeReport[]>;
    bySector: Record<string, UniqueTradeReport[]>;
  };
}

// ============================================
// Config Types
// ============================================

export interface AnalysisConfig {
  marketCapThreshold: number; // Default: 2 billion
  volumeThresholdMultiplier: number; // Trade size vs avg volume
  convictionThresholdMultiplier: number; // Trade size vs member avg
  minUniquenessScore: number; // Minimum score to include in report
}

export const DEFAULT_ANALYSIS_CONFIG: AnalysisConfig = {
  marketCapThreshold: 2_000_000_000, // $2B
  volumeThresholdMultiplier: 0.1, // Trade represents > 10% of avg volume
  convictionThresholdMultiplier: 2, // Trade is 2x member's average
  minUniquenessScore: 50,
};
