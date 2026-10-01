/**
 * Trade groups
 *
 * Members often split one decision into several line items: five lots of the
 * same stock on the same day, or a position built over a few days. Scored one
 * by one, each lot looks small and the stock looks heavily traded, and the
 * ranked list repeats the same story several times. A group is a member's
 * trades in one stock on the same side, each within `maxGapDays` of the one
 * before it; the analysis scores a group as one trade and every trade in it
 * carries that score.
 */

import type { FMPTrade } from "../types/index.js";
import type { AnalyzedTrade } from "./analysis-service.js";

export type TradeSide = "purchase" | "sale" | "exchange" | "other";

export function tradeSide(type: string | undefined | null): TradeSide {
  const t = (type ?? "").toLowerCase();
  if (t.includes("purchase")) return "purchase";
  if (t.includes("sale")) return "sale";
  if (t.includes("exchange")) return "exchange";
  return "other";
}

/** "$1,001 - $15,000" → {low: 1001, high: 15000}; "Over $50,000,000" → {low: 50000000, high: null}. */
export function amountRange(amount: string | undefined | null): { low: number | null; high: number | null } {
  const nums = (amount ?? "").match(/\$[\d,]+/g)?.map((n) => Number(n.replace(/[$,]/g, ""))) ?? [];
  if (!nums.length) return { low: null, high: null };
  if (/over/i.test(amount ?? "")) return { low: nums[0], high: null };
  return { low: nums[0], high: nums[1] ?? nums[0] };
}

/**
 * The amounts of several trades added up, in the disclosure's own format.
 * Trades with no amount are left out; an open-ended one ("Over $50,000,000")
 * makes the total open-ended. Null when none of them gave an amount.
 */
export function sumAmounts(amounts: Array<string | undefined | null>): string | null {
  let low = 0, high = 0, open = false, any = false;
  for (const a of amounts) {
    const r = amountRange(a);
    if (r.low === null) continue;
    any = true;
    low += r.low;
    if (r.high === null) open = true;
    else high += r.high;
  }
  if (!any) return null;
  const fmt = (n: number) => `$${n.toLocaleString("en-US")}`;
  return open ? `Over ${fmt(low)}` : low === high ? fmt(low) : `${fmt(low)} - ${fmt(high)}`;
}

const DAY_MS = 86_400_000;

/**
 * Split items into groups. Items whose key is null, or that have no usable
 * date, stay on their own. Within a key, items sorted by date join the current
 * group while each is at most `maxGapDays` after the previous one.
 * Groups come back in input order of their first item.
 */
export function groupBy<T>(
  items: T[],
  keyOf: (item: T) => string | null,
  dateOf: (item: T) => string | undefined | null,
  maxGapDays: number
): T[][] {
  const byKey = new Map<string, Array<{ item: T; at: number; index: number }>>();
  const groups: Array<{ first: number; items: T[] }> = [];

  items.forEach((item, index) => {
    const key = keyOf(item);
    const at = Date.parse(dateOf(item) ?? "");
    if (key === null || isNaN(at)) {
      groups.push({ first: index, items: [item] });
      return;
    }
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push({ item, at, index });
  });

  for (const list of byKey.values()) {
    list.sort((a, b) => a.at - b.at || a.index - b.index);
    let current: typeof list = [];
    const flush = () => {
      if (current.length) groups.push({ first: Math.min(...current.map((c) => c.index)), items: current.map((c) => c.item) });
    };
    for (const entry of list) {
      const last = current[current.length - 1];
      if (last && (entry.at - last.at) / DAY_MS > maxGapDays) {
        flush();
        current = [];
      }
      current.push(entry);
    }
    flush();
  }

  return groups.sort((a, b) => a.first - b.first).map((g) => g.items);
}

/**
 * Group key for a trade: member + asset + side. The asset is the ticker, or for
 * a trade without one (bonds, private funds, unresolved scans) its description,
 * matched exactly apart from case and spacing so different bond issues never
 * merge. A trade with neither is never grouped.
 */
export function tradeGroupKey(memberId: string, trade: FMPTrade): string | null {
  const symbol = trade.symbol?.trim().toUpperCase();
  const asset = symbol || (trade.assetDescription ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  if (!asset) return null;
  return `${memberId}|${symbol ? "" : "desc:"}${asset}|${tradeSide(trade.type)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading groups back out of an analysis
// ─────────────────────────────────────────────────────────────────────────────

export interface TradeGroup {
  /** The trades, earliest first. One for a trade that wasn't grouped. */
  trades: AnalyzedTrade[];
  /** The earliest trade, which stands in for the group's member, ticker and asset. */
  lead: AnalyzedTrade;
  /** The group's score, shared by every trade in it. */
  score: AnalyzedTrade["score"];
  firstDate: string | undefined;
  lastDate: string | undefined;
  /** The trades' amounts added up, or the lone trade's own amount. */
  amount: string | undefined;
}

/**
 * Split items by the analysis group each belongs to, keeping the order in which
 * each group first appears. Items with no group id stand alone. Used wherever a
 * group should count as one trade, such as the new-trade counts.
 */
export function splitByGroupId<T>(items: T[], groupIdOf: (item: T) => string | undefined): T[][] {
  const order: T[][] = [];
  const byId = new Map<string, T[]>();
  for (const item of items) {
    const id = groupIdOf(item);
    if (!id) {
      order.push([item]);
      continue;
    }
    let list = byId.get(id);
    if (!list) {
      list = [];
      byId.set(id, list);
      order.push(list);
    }
    list.push(item);
  }
  return order;
}

/**
 * Collect analyzed trades into their groups, keeping the order in which each
 * group first appears. Trades without a groupId (single trades, and every trade
 * in a report saved before grouping existed) form a group of one.
 */
export function collectGroups(scored: AnalyzedTrade[]): TradeGroup[] {
  return splitByGroupId(scored, (t) => t.groupId).map((list) => {
    const trades = [...list].sort((a, b) => (a.trade.transactionDate ?? "").localeCompare(b.trade.transactionDate ?? ""));
    const lead = trades[0];
    return {
      trades,
      lead,
      score: lead.score,
      firstDate: lead.trade.transactionDate,
      lastDate: trades[trades.length - 1].trade.transactionDate,
      amount: trades.length > 1 ? sumAmounts(trades.map((t) => t.trade.amount)) ?? undefined : lead.trade.amount,
    };
  });
}
