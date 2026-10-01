import type { FMPTrade } from "../types/index.js";

/**
 * Normalize a filing date to ISO (YYYY-MM-DD) so it can be compared and sorted.
 *
 * Providers hand us `dateRecieved` (FMP's typo, kept for schema compatibility)
 * as a US-style "M/D/YYYY" string — "9/9/2026", "01/06/2026". Those sort
 * lexically into nonsense, which is why the field has been written by every
 * provider but never read. ISO strings compare correctly as plain strings.
 *
 * Returns null for anything that isn't a recognizable date, so callers can
 * treat "unknown filing date" as "not new" rather than guessing.
 */
export function filingDateIso(trade: FMPTrade): string | null {
  const raw = trade.dateRecieved?.trim();
  if (!raw) return null;

  // Already ISO (some OCR'd filings come through this way).
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return raw;

  const us = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!us) return null;
  const [, m, d, y] = us;
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

/** Latest filing date across a set of trades, or null if none are parseable. */
export function maxFilingDate(trades: FMPTrade[]): string | null {
  let max: string | null = null;
  for (const trade of trades) {
    const iso = filingDateIso(trade);
    if (iso && (max === null || iso > max)) max = iso;
  }
  return max;
}

/**
 * Build a predicate for "disclosed since the previous run".
 *
 * A trade stamped with `firstSeen` is new when this service first stored it
 * after the previous report ran (`foundAfter`) and no later than this report
 * (`foundThrough`, for rebuilding an earlier report). Filing dates can't decide
 * that: the House posts paper filings days after the date they were received, so
 * a late-posted filing can carry a date older than ones already reported.
 *
 * Trades stored before `firstSeen` was recorded fall back to comparing their
 * filing date with `baseline`, the previous run's high-water filing date.
 *
 * With no previous report nothing is marked new: better a quiet page than one
 * where all 10k rows light up.
 */
export function createNewlyDisclosedPredicate(
  baseline: string | null,
  window: { foundAfter?: string | null; foundThrough?: string } = {}
): (trade: FMPTrade) => boolean {
  const { foundAfter, foundThrough } = window;
  if (!baseline && !foundAfter) return () => false;
  return (trade) => {
    if (trade.firstSeen) {
      return (!foundAfter || trade.firstSeen > foundAfter) && (!foundThrough || trade.firstSeen <= foundThrough);
    }
    const iso = filingDateIso(trade);
    return baseline !== null && iso !== null && iso > baseline;
  };
}
