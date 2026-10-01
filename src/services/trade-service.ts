import type { FMPTrade, TradeData } from "../types/index.js";
import type { TradeSourceProvider } from "../data/trade-source.js";
import { HouseDataUnavailableError } from "../data/stock-watcher-provider.js";
import { saveData, loadData } from "../utils/storage.js";

const TRADES_FILE = "trades.json";

/**
 * Get the default target date (1 year ago for refresh mode)
 */
export function getDefaultTargetDate(): Date {
  const date = new Date();
  date.setFullYear(date.getFullYear() - 1);
  return date;
}

/**
 * Generate a unique key for a trade to detect duplicates.
 *
 * Includes assetDescription because symbol-less trades (e.g. government
 * securities/bonds) can otherwise collide: the same member can legitimately
 * buy two different bonds on the same date, for the same amount range and
 * owner, that would look identical without the description.
 */
export function getTradeKey(trade: FMPTrade): string {
  return [
    trade.firstName || "",
    trade.lastName || "",
    trade.transactionDate || "",
    trade.symbol || "",
    trade.type || "",
    trade.amount || "",
    trade.owner || "",
    trade.assetDescription || "",
  ].join("|");
}

/**
 * Get the most recent trade date from an array of trades
 */
function getMostRecentTradeDate(trades: FMPTrade[]): Date | null {
  if (trades.length === 0) return null;

  const dates = trades
    .map((t) => t.transactionDate)
    .filter((d): d is string => !!d)
    .map((d) => new Date(d))
    .filter((d) => !isNaN(d.getTime()));

  if (dates.length === 0) return null;

  return new Date(Math.max(...dates.map((d) => d.getTime())));
}

/**
 * Merge new trades with existing trades, removing duplicates.
 *
 * Dedupes against existing trades AND within newTrades itself — a single
 * source fetch/parse can emit the same line item more than once (e.g. a
 * PDF table row parsed twice), and since that happens within one batch,
 * checking only against previously-seen trades would let both copies through.
 */
function mergeTrades(existing: FMPTrade[], newTrades: FMPTrade[], now: string): FMPTrade[] {
  const seenKeys = new Set(existing.map(getTradeKey));
  const uniqueNewTrades: FMPTrade[] = [];

  for (const trade of newTrades) {
    const key = getTradeKey(trade);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    uniqueNewTrades.push({ ...trade, firstSeen: trade.firstSeen ?? now });
  }

  return [...existing, ...uniqueNewTrades];
}

/**
 * A refresh refetches everything, so carry each trade's firstSeen over from the
 * data it replaces. Only trades that weren't stored before count as found now.
 */
export function carryFirstSeen(previous: FMPTrade[], fetched: FMPTrade[], now: string): FMPTrade[] {
  const before = new Map(previous.map((t) => [getTradeKey(t), t]));
  return fetched.map((t) => {
    const old = before.get(getTradeKey(t));
    const firstSeen = old ? old.firstSeen : t.firstSeen ?? now;
    return firstSeen ? { ...t, firstSeen } : t;
  });
}

/**
 * Fetch trades from FMP, with support for incremental updates
 *
 * @param fmpClient - FMP client for API calls
 * @param targetDate - Date to fetch back to (for refresh mode)
 * @param limit - Number of trades per page
 * @param refresh - If true, clears existing data and fetches from targetDate. If false (default), fetches only new trades since most recent existing trade
 * @returns Trade data
 */
export async function fetchTrades(
  provider: TradeSourceProvider,
  targetDate: Date,
  _limit = 100,
  refresh = false
): Promise<TradeData> {
  let existingData: TradeData | null = null;
  let startDate: Date;
  // The Senate gets its own start date: basing it on the newest trade across
  // both chambers lets a lagging Senate feed (e.g. after an outage) fall
  // permanently behind. Seen-GUID tracking prevents reprocessing the overlap.
  let senateStartDate: Date | null = null;

  if (refresh) {
    startDate = targetDate;
    console.log(`🔄 Refresh mode: Fetching all trades since ${startDate.toISOString().split("T")[0]}`);
  } else {
    existingData = await loadTrades();

    if (!existingData) {
      startDate = targetDate;
      console.log(`📥 No existing data found. Fetching trades since ${startDate.toISOString().split("T")[0]}`);
    } else {
      const senateMostRecent = getMostRecentTradeDate(existingData.senateTrades);
      const houseMostRecent = getMostRecentTradeDate(existingData.houseTrades);

      const mostRecentDate = [senateMostRecent, houseMostRecent]
        .filter((d): d is Date => d !== null)
        .reduce((latest, current) => (current > latest ? current : latest), new Date(0));

      if (mostRecentDate.getTime() === 0) {
        startDate = targetDate;
        console.log(`⚠️  No valid dates in existing data. Fetching since ${startDate.toISOString().split("T")[0]}`);
      } else {
        startDate = new Date(mostRecentDate);
        startDate.setDate(startDate.getDate() - 1);
        console.log(
          `📈 Incremental update: Most recent trade is ${mostRecentDate.toISOString().split("T")[0]}, ` +
          `fetching since ${startDate.toISOString().split("T")[0]}`
        );

        if (senateMostRecent && senateMostRecent < startDate) {
          senateStartDate = new Date(senateMostRecent);
          senateStartDate.setDate(senateStartDate.getDate() - 7);
          console.log(
            `📈 Senate lags: most recent Senate trade is ${senateMostRecent.toISOString().split("T")[0]}, ` +
            `fetching Senate since ${senateStartDate.toISOString().split("T")[0]}`
          );
        }
      }
    }
  }

  console.log(`\nFetching new trades via ${provider.getName()}...`);
  const now = new Date().toISOString();

  const newSenateTrades = await provider.fetchSenateTrades(senateStartDate ?? startDate);

  let newHouseTrades: FMPTrade[];
  try {
    newHouseTrades = await provider.fetchHouseTrades(startDate);
  } catch (err) {
    if (err instanceof HouseDataUnavailableError) {
      console.warn(`\n⚠️  ${err.message}`);
      console.warn("   Using cached House trade data unchanged.\n");
      newHouseTrades = existingData?.houseTrades ?? [];
    } else {
      throw err;
    }
  }

  console.log(`\nFetched:`);
  console.log(`  Senate: ${newSenateTrades.length} trades`);
  console.log(`  House: ${newHouseTrades.length} trades (${existingData?.houseTrades?.length === newHouseTrades.length ? "cached" : "fetched"})`);

  let finalSenateTrades: FMPTrade[];
  let finalHouseTrades: FMPTrade[];

  if (!refresh && existingData) {
    console.log(`\n🔗 Merging with existing data...`);
    console.log(`  Existing: ${existingData.senateTrades.length} Senate, ${existingData.houseTrades.length} House`);

    finalSenateTrades = mergeTrades(existingData.senateTrades, newSenateTrades, now);
    finalHouseTrades = mergeTrades(existingData.houseTrades, newHouseTrades, now);

    const senateAdded = finalSenateTrades.length - existingData.senateTrades.length;
    const houseAdded = finalHouseTrades.length - existingData.houseTrades.length;

    console.log(`  Added: ${senateAdded} new Senate trades, ${houseAdded} new House trades`);
    console.log(`  Final: ${finalSenateTrades.length} Senate, ${finalHouseTrades.length} House`);
  } else {
    const previous = refresh ? await loadTrades() : null;
    finalSenateTrades = carryFirstSeen(previous?.senateTrades ?? [], newSenateTrades, now);
    finalHouseTrades = carryFirstSeen(previous?.houseTrades ?? [], newHouseTrades, now);
  }

  const tradeData: TradeData = {
    senateTrades: finalSenateTrades,
    houseTrades: finalHouseTrades,
  };

  await saveData(TRADES_FILE, tradeData);
  console.log(`\n💾 Trades saved to ${TRADES_FILE}`);

  return tradeData;
}

/**
 * Load cached trade data
 */
export async function loadTrades(): Promise<TradeData | null> {
  const stored = await loadData<TradeData>(TRADES_FILE);
  return stored?.data || null;
}

/**
 * Get unique traders from trade data
 */
export function getUniqueTraders(
  trades: FMPTrade[]
): { name: string; count: number }[] {
  const traderCounts = new Map<string, number>();

  for (const trade of trades) {
    const name = `${trade.firstName || ""} ${trade.lastName || ""}`.trim();
    if (name) {
      traderCounts.set(name, (traderCounts.get(name) || 0) + 1);
    }
  }

  return [...traderCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Get trade statistics
 */
export function getTradeStats(trades: FMPTrade[]): {
  total: number;
  purchases: number;
  sales: number;
  byType: Record<string, number>;
  uniqueSymbols: number;
  uniqueTraders: number;
} {
  const byType: Record<string, number> = {};
  const symbols = new Set<string>();
  const traders = new Set<string>();

  let purchases = 0;
  let sales = 0;

  for (const trade of trades) {
    const type = (trade.type || "unknown").toLowerCase();
    byType[type] = (byType[type] || 0) + 1;

    if (type.includes("purchase")) purchases++;
    if (type.includes("sale")) sales++;

    if (trade.symbol) symbols.add(trade.symbol);

    const name = `${trade.firstName || ""} ${trade.lastName || ""}`.trim();
    if (name) traders.add(name);
  }

  return {
    total: trades.length,
    purchases,
    sales,
    byType,
    uniqueSymbols: symbols.size,
    uniqueTraders: traders.size,
  };
}

/**
 * Filter trades by date range
 */
export function filterTradesByDate(
  trades: FMPTrade[],
  startDate?: Date,
  endDate?: Date
): FMPTrade[] {
  return trades.filter((trade) => {
    if (!trade.transactionDate) return false;

    const tradeDate = new Date(trade.transactionDate);

    if (startDate && tradeDate < startDate) return false;
    if (endDate && tradeDate > endDate) return false;

    return true;
  });
}

/**
 * Filter trades by symbol
 */
export function filterTradesBySymbol(
  trades: FMPTrade[],
  symbols: string[]
): FMPTrade[] {
  const symbolSet = new Set(symbols.map((s) => s.toUpperCase()));
  return trades.filter(
    (trade) => trade.symbol && symbolSet.has(trade.symbol.toUpperCase())
  );
}

/**
 * Filter trades by trader name
 */
export function filterTradesByTrader(
  trades: FMPTrade[],
  firstName?: string,
  lastName?: string
): FMPTrade[] {
  return trades.filter((trade) => {
    if (firstName && trade.firstName?.toLowerCase() !== firstName.toLowerCase()) {
      return false;
    }
    if (lastName && trade.lastName?.toLowerCase() !== lastName.toLowerCase()) {
      return false;
    }
    return true;
  });
}
