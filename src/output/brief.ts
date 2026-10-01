import type { AnalysisReport, AnalyzedTrade } from "../services/analysis-service.js";
import type { FMPTrade } from "../types/index.js";
import type { UniquenessResult } from "../scoring/types.js";
import { filingDateIso } from "../utils/filing-date.js";
import { COMMITTEE_NAMES, FLAG_DESCRIPTIONS, buildScoreLookup, tradeKey, type MemberLinker } from "./html.js";

// The agent-readable brief: what one report newly disclosed, scored, as JSON.
// Published as latest.json at the site root and kept per run as <date>/brief.json.

export const BRIEF_SCHEMA = "outlier-caucus/brief@1";

export interface BriefOptions {
  report: AnalysisReport;
  /** Every trade on file; the brief picks out the newly disclosed ones. */
  trades: FMPTrade[];
  isNewlyDisclosed: (trade: FMPTrade) => boolean;
  /** False on the first report, when nothing counts as new. */
  hasPrevious: boolean;
  /** Previous run's filing high-water mark, which decides newness for trades stored without firstSeen. */
  filingBaseline: string | null;
  /** When the previous report ran; trades first seen after it are new. */
  foundAfter: string | null;
  previousReport?: { date: string; label: string };
  reportDate: string;
  reportLabel: string;
  resolveParty: (trade: FMPTrade) => string | undefined;
  /** Member page filename within the report's folder, or null. */
  memberLink: MemberLinker;
  topWindowDays: number;
}

const round = (v: number, dp = 0) => Math.round(v * 10 ** dp) / 10 ** dp;

function side(type: string | undefined): "purchase" | "sale" | "exchange" | "other" {
  const t = (type ?? "").toLowerCase();
  if (t.includes("purchase")) return "purchase";
  if (t.includes("sale")) return "sale";
  if (t.includes("exchange")) return "exchange";
  return "other";
}

/** "$1,001 - $15,000" → {low: 1001, high: 15000}; "Over $50,000,000" → {low: 50000000, high: null}. */
export function amountRange(amount: string | undefined): { low: number | null; high: number | null } {
  const nums = (amount ?? "").match(/\$[\d,]+/g)?.map((n) => Number(n.replace(/[$,]/g, ""))) ?? [];
  if (!nums.length) return { low: null, high: null };
  if (/over/i.test(amount ?? "")) return { low: nums[0], high: null };
  return { low: nums[0], high: nums[1] ?? nums[0] };
}

function daysBetween(from: string | undefined | null, to: string | null): number | null {
  if (!from || !to) return null;
  const ms = Date.parse(to) - Date.parse(from);
  return isNaN(ms) ? null : Math.round(ms / 86_400_000);
}

/** Why the trade scored as it did, one plain sentence per flag. */
function reasons(score: UniquenessResult): string[] {
  const { flags, explanation: ex } = score;
  const out: string[] = [];
  if (flags.isRareStock) {
    const n = ex.rarity?.totalCongressTrades;
    out.push(n === undefined ? "Rarely traded by Congress"
      : n <= 1 ? "The only congressional trade in this asset"
      : `Congress has traded it ${n} times, by ${ex.rarity!.uniqueTraders} member(s)`);
  }
  if (flags.isHighConviction && ex.conviction)
    out.push(`${ex.conviction.multiplier.toFixed(1)}x this member's usual trade size`);
  if (flags.hasCommitteeRelevance && ex.committeeRelevance) {
    const rel = ex.committeeRelevance;
    const sector = [rel.stockSector, rel.stockIndustry].filter(Boolean).join(" / ") || "this sector";
    const names = rel.overlappingCommittees.map((id) => COMMITTEE_NAMES.get(id) ?? id).join("; ");
    out.push(`Sits on ${names || "a committee"} with oversight of ${sector}`);
  }
  if (flags.isSmallCap && ex.marketCap) out.push(`${ex.marketCap.category} cap, $${round(ex.marketCap.value / 1e6)}M market value`);
  if (flags.isDerivative) out.push(`Derivative (${ex.derivative?.assetType ?? "options or similar"})`);
  if (flags.isIndirectOwnership && ex.ownership) out.push(`Held through a ${ex.ownership.owner.toLowerCase()} account`);
  return out;
}

function tradeEntry(
  trade: FMPTrade,
  analyzed: AnalyzedTrade | undefined,
  opts: BriefOptions
) {
  const score = analyzed?.score;
  const filed = filingDateIso(trade);
  const memberFile = opts.memberLink(trade);
  const ex = score?.explanation;
  return {
    member: `${trade.firstName ?? ""} ${trade.lastName ?? ""}`.trim(),
    party: opts.resolveParty(trade) ?? null,
    chamber: analyzed?.chamber ?? null,
    symbol: trade.symbol ?? null,
    asset: trade.assetDescription ?? null,
    assetType: trade.assetType ?? null,
    side: side(trade.type),
    type: trade.type ?? null,
    amount: trade.amount ?? null,
    amountRange: amountRange(trade.amount),
    owner: trade.owner ?? null,
    transactionDate: trade.transactionDate ?? null,
    filedDate: filed,
    foundAt: trade.firstSeen ?? null,
    disclosureLagDays: daysBetween(trade.transactionDate, filed),
    postedLagDays: trade.firstSeen ? daysBetween(filed, trade.firstSeen.slice(0, 10)) : null,
    score: score?.overallScore ?? null,
    flags: score ? (Object.keys(FLAG_DESCRIPTIONS) as Array<keyof UniquenessResult["flags"]>).filter((k) => score.flags[k]) : [],
    reasons: score ? reasons(score) : [],
    sector: ex?.committeeRelevance?.stockSector ?? null,
    industry: ex?.committeeRelevance?.stockIndustry ?? null,
    marketCap: ex?.marketCap && ex.marketCap.category !== "unknown" ? ex.marketCap.value : null,
    congressTradesInAsset: ex?.rarity?.totalCongressTrades ?? null,
    fromScannedFiling: trade.source === "ocr",
    filing: trade.link ?? null,
    memberPage: memberFile ? `${opts.reportDate}/${memberFile}` : null,
  };
}

export type BriefTrade = ReturnType<typeof tradeEntry>;

/** Tickers that two or more members traded in this batch of disclosures. */
function clusters(entries: BriefTrade[]) {
  const bySymbol = new Map<string, BriefTrade[]>();
  for (const e of entries) {
    if (!e.symbol) continue;
    if (!bySymbol.has(e.symbol)) bySymbol.set(e.symbol, []);
    bySymbol.get(e.symbol)!.push(e);
  }
  return [...bySymbol.entries()]
    .map(([symbol, es]) => {
      const members = (s: string) => [...new Set(es.filter((e) => e.side === s).map((e) => e.member))];
      return { symbol, asset: es[0].asset, members: new Set(es.map((e) => e.member)).size, trades: es.length,
        buyers: members("purchase"), sellers: members("sale") };
    })
    .filter((c) => c.members >= 2)
    .sort((a, b) => b.members - a.members || b.trades - a.trades || a.symbol.localeCompare(b.symbol));
}

export function buildBrief(opts: BriefOptions) {
  const { report } = opts;
  const scoreLookup = buildScoreLookup(report);
  const entry = (t: FMPTrade) => tradeEntry(t, scoreLookup.get(tradeKey(t)), opts);

  const newFilings = opts.trades
    .filter(opts.isNewlyDisclosed)
    .map(entry)
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || (b.filedDate ?? "").localeCompare(a.filedDate ?? ""));

  const count = (s: string) => newFilings.filter((e) => e.side === s).length;
  const lags = newFilings.map((e) => e.disclosureLagDays).filter((d): d is number => d !== null).sort((a, b) => a - b);

  const cutoff = new Date(report.generatedAt);
  cutoff.setDate(cutoff.getDate() - opts.topWindowDays);
  const topPurchases = report.scoredTrades
    .filter((t) => side(t.trade.type) === "purchase" && t.trade.transactionDate && new Date(t.trade.transactionDate) >= cutoff)
    .sort((a, b) => b.score.overallScore - a.score.overallScore)
    .slice(0, 10)
    .map((t) => tradeEntry(t.trade, t, opts));

  return {
    schema: BRIEF_SCHEMA,
    generatedAt: report.generatedAt,
    reportDate: opts.reportDate,
    reportLabel: opts.reportLabel,
    about:
      "Stock trades by members of the US Congress, from their periodic transaction reports to the House Clerk and Senate eFD. " +
      "Checked weekday mornings at about 7:00 America/Denver; a new report and brief are written only when new trades turned up, " +
      "so reportDate is the last day anything new was found. Members have up to 45 days to disclose a trade, so check disclosureLagDays " +
      "before treating one as timely. Scores rank how unusual a trade is, not whether it was informed. Paths are relative to the " +
      "site root, where latest.json lives. Not investment advice.",
    newSince: opts.hasPrevious
      ? { previousReport: opts.previousReport?.date ?? null, foundAfter: opts.foundAfter, filedAfter: opts.filingBaseline }
      : null,
    links: {
      report: `${opts.reportDate}/report.html`,
      brief: `${opts.reportDate}/brief.json`,
      archive: "archive.html",
      reports: "manifest.json",
    },
    glossary: {
      newFilings: "Trades this service first found after the previous report ran (newSince.foundAfter); trades stored before that was recorded count as new when filed after newSince.filedAfter. Highest score first. Empty, with newSince null, on the first report.",
      score: "Uniqueness score, 0 to 100: a weighted blend of company size, trade size against the member's usual, how rarely Congress trades the asset, committee oversight of its sector, derivatives, and indirect ownership. null when the trade could not be scored.",
      flags: Object.fromEntries(Object.entries(FLAG_DESCRIPTIONS).map(([k, v]) => [k, v.title])),
      reasons: "The flags spelled out with the numbers behind them.",
      amountRange: "The disclosed dollar band, parsed. Filings give a range, never an exact amount; high is null for open-ended bands.",
      disclosureLagDays: "Days from the trade to its filing.",
      foundAt: "When this service first found the trade. null for trades stored before that was recorded.",
      postedLagDays: "Days from the filing date to foundAt. The House posts paper filings days after receiving them, so a large value means the news is older than the filing date suggests.",
      fromScannedFiling: "Read by OCR from a scanned paper filing; check it against the filing link.",
      clusters: "Tickers that two or more members traded among the new filings.",
      topPurchases: `The highest-scoring purchases made in the ${opts.topWindowDays} days before this report, new or not, for context.`,
    },
    summary: {
      newTrades: newFilings.length,
      purchases: count("purchase"),
      sales: count("sale"),
      exchanges: count("exchange"),
      members: new Set(newFilings.map((e) => e.member)).size,
      symbols: new Set(newFilings.map((e) => e.symbol).filter(Boolean)).size,
      committeeRelevant: newFilings.filter((e) => e.flags.includes("hasCommitteeRelevance")).length,
      medianDisclosureLagDays: lags.length ? lags[Math.floor(lags.length / 2)] : null,
      highestScoring: newFilings.slice(0, 3).map((e) => ({ member: e.member, symbol: e.symbol, side: e.side, score: e.score })),
    },
    clusters: clusters(newFilings),
    newFilings,
    topPurchases,
  };
}

export type Brief = ReturnType<typeof buildBrief>;
