import type { AnalysisReport, AnalyzedTrade } from "../services/analysis-service.js";
import type { FMPTrade } from "../types/index.js";
import type { UniquenessResult } from "../scoring/types.js";
import { SENATE_COMMITTEE_TAXONOMY, HOUSE_COMMITTEE_TAXONOMY } from "../data/committee-sector-taxonomy.js";
import { memberKey } from "./member-identity.js";
import { HTML_OPEN, THEME_JS, themeHead, siteHeader, shortDate, shortAmount, tidyAsset } from "./theme.js";

/** Returns the member page filename for a trade's filer, or null if no page exists */
export type MemberLinker = (trade: FMPTrade) => string | null;

export const COMMITTEE_NAMES = new Map<string, string>(
  [...SENATE_COMMITTEE_TAXONOMY, ...HOUSE_COMMITTEE_TAXONOMY].map(
    (c) => [c.committeeId, c.committeeName]
  )
);

// ─────────────────────────────────────────────────────────────────────────────
// TradingView link helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Map FMP exchangeShortName → TradingView exchange prefix */
function mapExchange(exchange: string | null | undefined): string | null {
  if (!exchange) return null;
  const e = exchange.toUpperCase();
  if (e.includes("NASDAQ")) return "NASDAQ";
  if (e.includes("AMEX") || e.includes("AMERICAN")) return "AMEX";
  if (e.startsWith("NYSE")) return "NYSE";
  if (e.includes("OTC") || e.includes("PINK")) return "OTC";
  if (e.includes("CBOE")) return "CBOE";
  return null; // TradingView will auto-detect for unknown exchanges
}

function tradingViewUrl(symbol: string, exchange: string | null | undefined): string {
  const prefix = mapExchange(exchange);
  const query = prefix ? `${prefix}:${symbol}` : symbol;
  return `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(query)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function esc(s: string | null | undefined): string {
  return (s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}


function partyClass(party: string | undefined): string {
  if (!party) return "";
  const p = party.toLowerCase();
  if (p.startsWith("r")) return "party-r";
  if (p.startsWith("d")) return "party-d";
  return "";
}

function partyLabel(party: string | undefined): string {
  if (!party) return "";
  if (party.toLowerCase().startsWith("r")) return "R";
  if (party.toLowerCase().startsWith("d")) return "D";
  return party.charAt(0);
}


function typeLabel(type: string | undefined): string {
  if (!type) return "N/A";
  const t = type.toLowerCase();
  if (t.includes("purchase")) return "Buy";
  if (t.includes("sale")) return "Sell";
  if (t.includes("exchange")) return "Exchange";
  return type;
}


/** Link to the original PTR filing (House Clerk PDF or Senate eFD page), when known. */
function filingLinkHtml(trade: FMPTrade): string {
  if (!trade.link) return "";
  const link = `<a class="filing-link" href="${esc(trade.link)}" target="_blank" rel="noopener noreferrer" title="Open the original disclosure">Filing</a>`;
  return trade.source === "ocr"
    ? `${link} <span class="option-tag" title="Read by OCR from a scanned paper filing. Check the original before relying on it.">Scanned</span>`
    : link;
}

function isOptionTrade(trade: FMPTrade): boolean {
  const t = (trade.assetType || "").toLowerCase();
  return t.includes("option") || t.includes("warrant") || t.includes("right");
}

/**
 * House PTRs sometimes abbreviate assetType to a short code instead of spelling
 * it out the way most filings do. Confirmed against this dataset by matching each
 * abbreviated code's asset descriptions to the same descriptions under the spelled-out
 * type (e.g. "Hologic, Inc." appears under both "PS" and "Stock (Not Publicly Traded)").
 */
const ASSET_TYPE_LABELS: Record<string, string> = {
  ST: "Stock",
  GS: "Government Securities and Agency Debt",
  OI: "Ownership Interest (Engaged in a Trade or Business)",
  RS: "Restricted Stock Units (RSUs)",
  PS: "Stock (Not Publicly Traded)",
  CS: "Corporate Securities (Bonds and Notes)",
  OT: "Other",
};

function assetTypeLabel(assetType: string | undefined): string {
  if (!assetType) return "";
  return ASSET_TYPE_LABELS[assetType.toUpperCase()] ?? assetType;
}

/**
 * Small inline tag flagging an options/derivative trade in table rows.
 * PTR filings rarely disclose call vs. put, strike, or expiration, so this
 * only signals "this leg is a derivative" — see the "Derivative" badge on
 * the scored cards for the full explanation.
 */
function optionTagHtml(trade: FMPTrade): string {
  if (!isOptionTrade(trade)) return "";
  return `<span class="option-tag" title="Derivative: Options, warrants, or other derivatives — signals timing sensitivity">Options</span>`;
}

/** Full party name for tooltips, matching the abbreviated party-tag pill (R/D). */
function partyFullName(party: string | undefined): string {
  if (!party) return "";
  const p = party.toLowerCase();
  if (p.startsWith("r")) return "Republican";
  if (p.startsWith("d")) return "Democrat";
  return party;
}

/** Same badge descriptions used on the Top Purchases / Committee-Relevant cards. */
export const FLAG_DESCRIPTIONS: Record<keyof UniquenessResult["flags"], { label: string; title: string }> = {
  isRareStock: { label: "Rare", title: "Stock rarely traded by Congress — fewer than 4 total trades" },
  isHighConviction: { label: "High Conviction", title: "Trade is significantly larger than this member's typical trade size" },
  hasCommitteeRelevance: { label: "Committee", title: "Trader serves on a committee that oversees this stock's sector — potential insider knowledge" },
  isDerivative: { label: "Derivative", title: "Options, warrants, or other derivatives — signals timing sensitivity" },
  isSmallCap: { label: "Small Cap", title: "Small or micro-cap stock (market cap below $2B) — less analyst coverage" },
  isIndirectOwnership: { label: "Indirect", title: "Trade made via a spouse or family member rather than directly by the member" },
};

function flagLabels(flags: UniquenessResult["flags"]): string[] {
  return (Object.keys(FLAG_DESCRIPTIONS) as Array<keyof UniquenessResult["flags"]>)
    .filter((k) => flags[k])
    .map((k) => FLAG_DESCRIPTIONS[k].label);
}

/** Committee badge tooltip: base description plus the full committee name(s) and sector. */
function committeeBadgeTitle(score: UniquenessResult): string {
  const base = `Committee: ${FLAG_DESCRIPTIONS.hasCommitteeRelevance.title}`;
  const rel = score.explanation.committeeRelevance;
  if (!rel) return base;
  const parts = [base];
  const sector = [rel.stockSector, rel.stockIndustry].filter(Boolean).join(" / ");
  if (sector) parts.push(`Sector: ${sector}`);
  if (rel.overlappingCommittees.length) {
    const names = rel.overlappingCommittees.map((id) => COMMITTEE_NAMES.get(id) ?? id).join(", ");
    parts.push(`Committees: ${names}`);
  }
  return parts.join(" — ");
}

/**
 * Signal words for the Member column. One or two words each, since table rows
 * are tight on space; the full description still shows on hover.
 */
function traderBadgesHtml(score: UniquenessResult): string {
  const badges: string[] = [];
  if (score.flags.isRareStock)
    badges.push(`<span class="badge badge-rare" title="Rare: ${esc(FLAG_DESCRIPTIONS.isRareStock.title)}">Rare</span>`);
  if (score.flags.isHighConviction)
    badges.push(`<span class="badge badge-conviction" title="High Conviction: ${esc(FLAG_DESCRIPTIONS.isHighConviction.title)}">Large</span>`);
  if (score.flags.hasCommitteeRelevance)
    badges.push(`<span class="badge badge-committee" title="${esc(committeeBadgeTitle(score))}">Committee</span>`);
  if (score.flags.isSmallCap)
    badges.push(`<span class="badge badge-smallcap" title="Small Cap: ${esc(FLAG_DESCRIPTIONS.isSmallCap.title)}">Small cap</span>`);
  return badges.join("");
}

/**
 * Derivative/options pill for the Trader column. Driven directly off the trade's
 * asset type (not the score lookup) so it never disappears for a trade that
 * didn't get matched to a scored AnalyzedTrade.
 */
function derivativeBadgeHtml(trade: FMPTrade): string {
  if (!isOptionTrade(trade)) return "";
  return `<span class="badge badge-derivative" title="Derivative: ${esc(FLAG_DESCRIPTIONS.isDerivative.title)}">Options</span>`;
}

/** Normalize a PTR owner field (which may be spelled out or abbreviated) to a short code + tooltip. */
const OWNER_CODES: Record<"spouse" | "joint" | "child", { code: string; title: string }> = {
  spouse: { code: "Spouse", title: "Spouse — trade made by the member's spouse rather than the member directly" },
  joint: { code: "Joint", title: "Joint — trade made jointly by the member and spouse" },
  child: { code: "Child", title: "Dependent Child — trade made by the member's dependent child" },
};

function ownerCode(owner: string): { code: string; title: string } {
  const o = owner.toLowerCase().trim();
  if (o.includes("spouse") || o === "sp") return OWNER_CODES.spouse;
  if (o.includes("child") || o.includes("dependent") || o === "dc") return OWNER_CODES.child;
  if (o.includes("joint") || o === "jt") return OWNER_CODES.joint;
  return { code: owner.toUpperCase(), title: `Owner: ${owner}` };
}

/** Owner word (Spouse/Joint/Child) for the Member column. */
function ownerPillHtml(owner: string): string {
  const { code, title } = ownerCode(owner);
  return `<span class="badge badge-indirect" title="${esc(title)}">${esc(code)}</span>`;
}

/** Composite key for matching an FMPTrade to its scored AnalyzedTrade counterpart. */
export function tradeKey(trade: FMPTrade): string {
  return [
    trade.link ?? "",
    trade.symbol ?? "",
    trade.transactionDate ?? "",
    trade.amount ?? "",
    trade.type ?? "",
    trade.owner ?? "",
    trade.firstName ?? "",
    trade.lastName ?? "",
  ].join("|");
}

export function buildScoreLookup(report: AnalysisReport): Map<string, AnalyzedTrade> {
  const lookup = new Map<string, AnalyzedTrade>();
  for (const analyzed of report.scoredTrades) lookup.set(tradeKey(analyzed.trade), analyzed);
  return lookup;
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV export
// ─────────────────────────────────────────────────────────────────────────────

function csvField(value: string | number): string {
  const s = String(value ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvRow(fields: Array<string | number>): string {
  return fields.map(csvField).join(",");
}

function buildCsv(headers: string[], rows: Array<Array<string | number>>): string {
  return [csvRow(headers), ...rows.map(csvRow)].join("\r\n");
}

const CARD_CSV_HEADERS = [
  "Date", "Symbol", "Type", "Amount", "Chamber", "Trader", "Party",
  "Score", "Flags", "Owner", "Asset Type", "Asset Description", "Filing Link",
];

function cardCsvRow(analyzed: AnalyzedTrade): Array<string | number> {
  const { trade, trader, score } = analyzed;
  const name = `${trade.firstName ?? ""} ${trade.lastName ?? ""}`.trim();
  const owner = trade.owner && trade.owner.toLowerCase() !== "self" ? trade.owner : "";
  return [
    trade.transactionDate ?? "",
    trade.symbol ?? "",
    typeLabel(trade.type),
    trade.amount ?? "",
    analyzed.chamber === "senate" ? "Senate" : "House",
    name,
    trader.party ?? "",
    score.overallScore,
    flagLabels(score.flags).join("; "),
    owner,
    assetTypeLabel(trade.assetType),
    trade.assetDescription ?? "",
    trade.link ?? "",
  ];
}

const SALE_CSV_HEADERS = [
  "Date", "Symbol", "Type", "Amount", "Trader", "Party", "Owner", "Options",
  "Score", "Flags", "Asset Type", "Asset Description", "Filing Link",
];

function saleCsvRow(
  trade: FMPTrade,
  party: string | undefined,
  analyzed: AnalyzedTrade | undefined
): Array<string | number> {
  const name = `${trade.firstName ?? ""} ${trade.lastName ?? ""}`.trim();
  const owner = trade.owner && trade.owner.toLowerCase() !== "self" ? trade.owner : "";
  return [
    trade.transactionDate ?? "",
    trade.symbol ?? "",
    typeLabel(trade.type),
    trade.amount ?? "",
    name,
    party ?? "",
    owner,
    isOptionTrade(trade) ? "Yes" : "",
    analyzed ? analyzed.score.overallScore : "",
    analyzed ? flagLabels(analyzed.score.flags).join("; ") : "",
    assetTypeLabel(trade.assetType),
    trade.assetDescription ?? "",
    trade.link ?? "",
  ];
}

/** A section-header "Export CSV" button; the actual CSV text is embedded in the page's csv-data script. */
function csvButtonHtml(sectionKey: string): string {
  return `<button class="csv-btn" type="button" data-csv-section="${esc(sectionKey)}">Download CSV</button>`;
}

/** Embeds each section's pre-built CSV text as JSON, read by the shared export click-handler. */
function csvDataScript(sections: Record<string, { filename: string; csv: string }>): string {
  return `<script type="application/json" id="csv-data">${JSON.stringify(sections)
    .replace(/</g, "\\u003c")}</script>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared cells
// ─────────────────────────────────────────────────────────────────────────────

const THIS_YEAR = String(new Date().getFullYear());

/** Ticker linked to its TradingView chart, or a "No ticker" marker for bonds, funds and unparsed rows. */
function symbolHtml(trade: FMPTrade, exchangeMap: Map<string, string>): string {
  if (!trade.symbol) return `<span class="no-ticker" title="The filing gives no ticker for this asset">No ticker</span>`;
  const url = tradingViewUrl(trade.symbol, exchangeMap.get(trade.symbol));
  return `<a class="symbol-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(trade.symbol)}</a>`;
}

function amountHtml(amount: string | undefined): string {
  const short = shortAmount(amount);
  return short && short !== amount ? `<span title="${esc(amount)}">${esc(short)}</span>` : esc(amount || "");
}

function partyTagHtml(party: string | undefined): string {
  const label = partyLabel(party);
  return label ? `<span class="party-tag ${partyClass(party)}" title="${esc(partyFullName(party))}">${esc(label)}</span>` : "";
}

function sideLabel(type: string | undefined): string {
  const t = (type || "").toLowerCase();
  if (t.includes("sale")) return "Sold";
  if (t.includes("exchange")) return "Exchanged";
  return "Bought";
}

function renderSaleRow(
  trade: FMPTrade,
  party: string | undefined,
  exchangeMap: Map<string, string>,
  memberLink?: MemberLinker,
  scoreLookup?: Map<string, AnalyzedTrade>,
  isNew = false
): string {
  const name = esc(`${trade.firstName ?? ""} ${trade.lastName ?? ""}`.trim());
  const memberUrl = memberLink?.(trade) ?? null;
  const nameHtml = memberUrl ? `<a href="${esc(memberUrl)}">${name}</a>` : name;
  const ownerRaw = trade.owner && trade.owner.toLowerCase() !== "self" ? trade.owner : "";
  const analyzed = scoreLookup?.get(tradeKey(trade));
  const signals = [
    analyzed ? traderBadgesHtml(analyzed.score) : "",
    derivativeBadgeHtml(trade),
    ownerRaw ? ownerPillHtml(ownerRaw) : "",
  ].filter(Boolean).join("");
  const filingLink = filingLinkHtml(trade);

  return `
<tr${isNew ? ' class="row-new"' : ""}>
  <td class="sale-date">${esc(shortDate(trade.transactionDate, THIS_YEAR))}${isNew ? ' <span class="new-tag" title="Disclosed since the previous report">New</span>' : ""}</td>
  <td class="sale-sym">${symbolHtml(trade, exchangeMap)}</td>
  <td class="sale-amount">${amountHtml(trade.amount)}</td>
  <td class="sale-trader"><div class="trader-cell">${nameHtml}${partyTagHtml(party)}${signals}</div></td>
  <td class="sale-desc">${esc(tidyAsset(trade.assetDescription))}${filingLink ? ` ${filingLink}` : ""}</td>
</tr>`;
}

function tradeTableHtml(
  rows: Array<{ trade: FMPTrade; party: string | undefined }>,
  exchangeMap: Map<string, string>,
  memberLink?: MemberLinker,
  scoreLookup?: Map<string, AnalyzedTrade>,
  isNewlyDisclosed: (trade: FMPTrade) => boolean = () => false
): string {
  return `<div class="sales-table-wrap">
        <table>
          <thead><tr><th>Traded</th><th>Ticker</th><th>Amount</th><th>Member</th><th>Asset</th></tr></thead>
          <tbody>
            ${rows.map(({ trade, party }) => renderSaleRow(trade, party, exchangeMap, memberLink, scoreLookup, isNewlyDisclosed(trade))).join("\n            ")}
          </tbody>
        </table>
      </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ranked "most unusual" entries
// ─────────────────────────────────────────────────────────────────────────────

function committeeAbbrs(ids: string[]): string {
  return ids.map((id) => {
    const fullName = COMMITTEE_NAMES.get(id);
    return fullName ? `<abbr class="committee-abbr" title="${esc(fullName)}">${esc(id)}</abbr>` : esc(id);
  }).join(", ");
}

function capText(value: number): string {
  return value >= 1e9 ? `$${+(value / 1e9).toFixed(1)}B` : `$${Math.round(value / 1e6)}M`;
}

function ownerPhrase(owner: string): string {
  const { code } = ownerCode(owner);
  if (code === "Spouse") return "Spouse's account";
  if (code === "Joint") return "Joint account";
  if (code === "Child") return "Dependent child's account";
  return `Owner: ${owner}`;
}

/** Why a trade scored the way it did, as short sentences (HTML). */
function reasonsHtml(score: UniquenessResult): string[] {
  const { flags, explanation: ex } = score;
  const out: string[] = [];
  if (flags.isRareStock && !ex.rarity) out.push("Rarely traded by Congress");
  if (ex.rarity) {
    const n = ex.rarity.totalCongressTrades;
    out.push(n <= 1 ? "The only congressional trade in it" : `Congress has traded it ${n} times`);
  }
  if (flags.isHighConviction && ex.conviction) out.push(`${ex.conviction.multiplier.toFixed(1)}× their usual trade size`);
  if (flags.hasCommitteeRelevance && ex.committeeRelevance) {
    const rel = ex.committeeRelevance;
    const sector = [rel.stockSector, rel.stockIndustry].filter(Boolean).join(" / ");
    const who = rel.overlappingCommittees.length ? `Sits on ${committeeAbbrs(rel.overlappingCommittees)}` : "Sits on a committee";
    out.push(`<span class="oversight">${who}, which oversees ${esc(sector || "this sector")}</span>`);
  }
  if (flags.isSmallCap && ex.marketCap) out.push(`Small company (${capText(ex.marketCap.value)})`);
  if (flags.isDerivative) out.push(ex.derivative ? esc(assetTypeLabel(ex.derivative.assetType)) : "Options or other derivative");
  if (flags.isIndirectOwnership && ex.ownership) out.push(esc(ownerPhrase(ex.ownership.owner)));
  return out;
}

function renderPick(analyzed: AnalyzedTrade, idx: string, exchangeMap: Map<string, string>, memberLink?: MemberLinker): string {
  const { trade, trader, score } = analyzed;
  const name = `${trade.firstName ?? ""} ${trade.lastName ?? ""}`.trim();
  const memberUrl = memberLink?.(trade) ?? null;
  const nameHtml = memberUrl ? `<a href="${esc(memberUrl)}">${esc(name)}</a>` : esc(name);
  const ex = score.explanation;
  const reasons = reasonsHtml(score);
  const facts: Array<[string, string]> = [
    ["Traded", esc(shortDate(trade.transactionDate, "any") || "Unknown")],
    ["Reported amount", esc(trade.amount || "Not given")],
  ];
  if (typeLabel(trade.type) !== "Buy") facts.push(["Transaction", esc(typeLabel(trade.type))]);
  if (ex.marketCap && ex.marketCap.category !== "unknown") facts.push(["Company size", `${capText(ex.marketCap.value)} (${esc(ex.marketCap.category)} cap)`]);
  if (ex.rarity) facts.push(["Congress trades in it", `${ex.rarity.totalCongressTrades} by ${ex.rarity.uniqueTraders} member${ex.rarity.uniqueTraders === 1 ? "" : "s"}`]);
  if (ex.conviction) facts.push(["Their usual trade", `${esc(shortAmount(`$${Math.round(ex.conviction.averageSize)}`))}, this one ${ex.conviction.multiplier.toFixed(1)}×`]);
  if (ex.committeeRelevance?.overlappingCommittees.length) facts.push(["Committees", committeeAbbrs(ex.committeeRelevance.overlappingCommittees)]);
  if (trade.assetType) facts.push(["Asset type", esc(assetTypeLabel(trade.assetType))]);
  if (trade.source === "ocr") facts.push(["Source", "Read from a scanned paper filing, so check it against the original"]);
  const chart = trade.symbol ? tradingViewUrl(trade.symbol, exchangeMap.get(trade.symbol)) : null;

  return `
<li class="pick trade-card" data-ticker="${trade.symbol ? 1 : 0}">
  <div class="pick-main">
    <div class="score" title="Uniqueness score ${score.overallScore} of 100"><b>${score.overallScore}</b><span class="track"><i style="width:${Math.min(100, Math.max(0, score.overallScore))}%"></i></span></div>
    <div class="asset">${trade.symbol ? `<span class="tick">${symbolHtml(trade, exchangeMap)}</span>` : `${symbolHtml(trade, exchangeMap)} `}<span class="name">${esc(tidyAsset(trade.assetDescription))}</span></div>
    <div class="who">${nameHtml} ${partyTagHtml(trader.party)}<small>${analyzed.chamber === "senate" ? "Senate" : "House"}</small></div>
    <div class="amt">${amountHtml(trade.amount)}<small>${sideLabel(trade.type) === "Bought" ? "" : `<span class="side-note">${sideLabel(trade.type)}</span> `}${esc(shortDate(trade.transactionDate, THIS_YEAR))}</small></div>
    <button class="more" type="button" aria-expanded="false" aria-controls="${idx}" aria-label="Details for ${esc(trade.symbol || tidyAsset(trade.assetDescription))}">
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 4.5 6 8.5l4-4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>
    </button>
    ${reasons.length ? `<p class="why">${reasons.join(". ")}.</p>` : ""}
  </div>
  <div class="pick-detail" id="${idx}">
    <dl>${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
    <div class="links">
      ${trade.link ? `<a href="${esc(trade.link)}" target="_blank" rel="noopener noreferrer">Open the filing</a>` : ""}
      ${memberUrl ? `<a href="${esc(memberUrl)}">All of ${esc(name)}'s trades</a>` : ""}
      ${chart ? `<a href="${esc(chart)}" target="_blank" rel="noopener noreferrer">Chart</a>` : ""}
    </div>
  </div>
</li>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Report page CSS + JS (on top of the shared theme)
// ─────────────────────────────────────────────────────────────────────────────

const REPORT_CSS = `
  /* 1. New since the last report (the hero) */
  .fresh { padding-top: 2.5rem; padding-bottom: 2.75rem; }
  .fresh-band { border-top: 1px solid var(--line); }
  .fresh h1 {
    margin-bottom: 0.4rem; font-size: clamp(1.9rem, 4.4vw, 3.1rem); line-height: 1.08;
    font-weight: 600; font-stretch: 78%; letter-spacing: -0.02em; max-width: 22ch;
  }
  .fresh .lede { margin-bottom: 2rem; color: var(--sub); max-width: 62ch; }
  .fresh .lede:last-child { margin-bottom: 0; }
  .filers { display: grid; grid-template-columns: repeat(auto-fit, minmax(19rem, 1fr)); gap: 1.25rem 2.5rem; }
  .filer h2 { margin-bottom: 0.35rem; font-size: 1.05rem; font-weight: 600; display: flex; align-items: baseline; gap: 0.5rem; }
  .filer h2 .count { color: var(--muted); font-weight: 400; font-size: 0.88rem; margin-left: auto; }
  .filing-list { list-style: none; padding: 0; border-top: 2px solid var(--signal); }
  .filing-list li { display: grid; grid-template-columns: 4.6rem 1fr auto; gap: 0.1rem 0.75rem; align-items: baseline; padding: 0.55rem 0; border-bottom: 1px solid var(--line); }
  .filing-list .side { font-size: 0.82rem; font-weight: 600; }
  .filing-list .side.sold { color: var(--muted); }
  .filing-list .what { min-width: 0; }
  .filing-list .what b { font-weight: 600; margin-right: 0.35rem; }
  .filing-list .what .desc { color: var(--sub); }
  .filing-list .size { text-align: right; font-size: 0.9rem; white-space: nowrap; }
  .filing-list .when { grid-column: 2 / 4; font-size: 0.8rem; color: var(--muted); }
  .filing-list .more-filed { display: block; grid-template-columns: none; font-size: 0.88rem; color: var(--sub); }

  /* 2. Most unusual purchases */
  .unusual, .every { border-top: 1px solid var(--line); }
  .unusual > .wrap { padding-top: 2.5rem; padding-bottom: 1rem; }
  .every > .wrap { padding-top: 2.5rem; padding-bottom: 2rem; }
  .band-head { display: flex; align-items: end; justify-content: space-between; gap: 1rem 2rem; flex-wrap: wrap; margin-bottom: 1.1rem; }
  .band-head h2 { font-size: 1.6rem; font-weight: 600; font-stretch: 85%; letter-spacing: -0.01em; }
  .band-head p { margin-top: 0.2rem; color: var(--sub); max-width: 58ch; font-size: 0.95rem; }
  .views { display: flex; gap: 0.5rem 0.75rem; flex-wrap: wrap; align-items: center; }
  .seg { display: inline-flex; border: 1px solid var(--line-strong); border-radius: 999px; padding: 2px; }
  .seg button { background: none; border: 0; border-radius: 999px; padding: 0.3rem 0.85rem; font-size: 0.86rem; color: var(--sub); white-space: nowrap; }
  .seg button[aria-pressed="true"], .seg button.active { background: var(--ink); color: var(--ground); }
  .check { display: inline-flex; gap: 0.4rem; align-items: center; font-size: 0.86rem; color: var(--sub); }
  .check input { accent-color: var(--signal); }
  .views .csv-btn { margin-left: 0; }

  .ranked { list-style: none; padding: 0; }
  .ranked[hidden], .pick[hidden] { display: none; }
  .pick { border-top: 1px solid var(--line); }
  .pick-main { display: grid; align-items: center; gap: 0.2rem 1.25rem; padding: 1rem 0; grid-template-columns: 7.5rem minmax(0, 1.5fr) minmax(0, 1fr) 8.5rem 2rem; }
  /* Every score sits on a 0–100 track, so 41 reads as "less than half of max". */
  .score { display: grid; gap: 0.3rem; }
  .score b { font-size: 1.7rem; font-weight: 600; font-stretch: 75%; line-height: 1; }
  .track { height: 4px; background: var(--line); border-radius: 2px; overflow: hidden; }
  .track i { display: block; height: 100%; background: var(--signal); }
  .pick .asset { min-width: 0; }
  .pick .tick { font-weight: 700; margin-right: 0.45rem; }
  .pick .name { color: var(--sub); }
  .why { grid-column: 2 / 3; margin-top: 0.15rem; font-size: 0.9rem; color: var(--sub); }
  .why .oversight { color: var(--ink); }
  .who { min-width: 0; }
  .who a { font-weight: 500; }
  .who .party-tag { margin-left: 0.2rem; }
  .who small, .amt small { display: block; color: var(--muted); font-size: 0.8rem; }
  .amt { text-align: right; }
  .amt .side-note { color: var(--ink); font-weight: 600; }
  .more { width: 2rem; height: 2rem; border-radius: 50%; border: 1px solid var(--line); background: none; display: grid; place-items: center; color: var(--sub); padding: 0; }
  .more:hover { border-color: var(--line-strong); color: var(--ink); }
  .more svg { transition: transform 160ms ease; }
  .pick.open .more svg { transform: rotate(180deg); }
  .pick-detail { display: none; padding: 0 0 1.2rem 8.75rem; }
  .pick.open .pick-detail { display: block; }
  .pick-detail dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.3rem 1.25rem; margin: 0; font-size: 0.9rem; max-width: 46rem; }
  .pick-detail dt { color: var(--muted); }
  .pick-detail dd { margin: 0; }
  .pick-detail .links { margin-top: 0.75rem; display: flex; flex-wrap: wrap; gap: 0.5rem 1.25rem; font-size: 0.9rem; }
  .ranked-foot { border-top: 1px solid var(--line); padding: 0.9rem 0; color: var(--muted); font-size: 0.88rem; display: flex; justify-content: space-between; align-items: center; gap: 1rem; flex-wrap: wrap; }
  .ranked-foot button { background: none; border: 1px solid var(--line-strong); border-radius: 999px; padding: 0.3rem 0.9rem; font-size: 0.86rem; }
  .ranked-foot button[hidden] { display: none; }
  .empty { padding: 1.5rem 0; color: var(--sub); border-top: 1px solid var(--line); }

  /* 3. Every trade */
  .tab-panel { display: none; }
  .tab-panel.active { display: block; }

  /* 4. Elsewhere: parties and past runs */
  .rest { border-top: 1px solid var(--line); }
  .elsewhere { padding-top: 2.5rem; padding-bottom: 2rem; display: grid; grid-template-columns: 1fr 1.2fr; gap: 2.5rem 4rem; }
  .elsewhere h2 { margin-bottom: 0.8rem; font-size: 1.1rem; font-weight: 600; }
  .browse { list-style: none; padding: 0; }
  .browse li { border-bottom: 1px solid var(--line); }
  .browse a { display: flex; justify-content: space-between; padding: 0.6rem 0; text-decoration: none; }
  .browse a:hover span:first-child { text-decoration: underline; text-decoration-color: var(--signal); text-underline-offset: 3px; }
  .browse .n { color: var(--muted); }
  .runs { display: grid; gap: 6px; height: 7rem; max-width: 30rem; }
  .runs a { display: flex; flex-direction: column; justify-content: end; height: 100%; text-decoration: none; gap: 4px; }
  .runs .bar { background: var(--line-strong); border-radius: 2px 2px 0 0; min-height: 2px; }
  .runs a:hover .bar, .runs a[aria-current] .bar { background: var(--signal); }
  .runs .d { font-size: 0.68rem; color: var(--muted); text-align: center; white-space: nowrap; }
  .runs-note { margin-top: 0.6rem; font-size: 0.85rem; color: var(--muted); max-width: 30rem; }

  @media (max-width: 860px) {
    .pick-main { grid-template-columns: 4.5rem minmax(0, 1fr) 2rem; }
    .score b { font-size: 1.4rem; }
    .pick .asset { grid-column: 2; }
    .more { grid-column: 3; grid-row: 1; }
    .why, .who, .amt { grid-column: 2 / 4; text-align: left; }
    .who small, .amt small { display: inline; margin-left: 0.4rem; }
    .pick-detail { padding-left: 5.75rem; }
    .elsewhere { grid-template-columns: 1fr; }
  }
  @media (max-width: 520px) {
    .filing-list li { grid-template-columns: 4rem 1fr; }
    .filing-list .size { grid-column: 2; text-align: left; }
    .pick-detail { padding-left: 0; }
    .pick-detail dl { grid-template-columns: 1fr; gap: 0; }
    .pick-detail dd { margin-bottom: 0.4rem; }
  }
`;

const REPORT_JS = `
(function () {
  // Report picker
  var run = document.getElementById('run');
  if (run) run.addEventListener('change', function () { location.href = run.value; });

  // The options were baked in when this report was built, so reports published
  // since are missing. Refill them from the live manifest and point to the latest.
  if (run && window.fetch) {
    fetch('../manifest.json', { cache: 'no-cache' })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (entries) {
        if (!Array.isArray(entries) || !entries.length) return;
        var here = run.dataset.date;
        run.textContent = '';
        entries.forEach(function (e) {
          var opt = document.createElement('option');
          opt.value = '../' + e.file;
          opt.textContent = e.dateLabel + (e.newTrades ? ' (' + e.newTrades + ' new)' : '');
          opt.selected = e.date === here;
          run.appendChild(opt);
        });
        var latest = entries[0];
        if (latest.date > here) {
          var link = document.createElement('a');
          link.className = 'run-latest';
          link.href = '../' + latest.file;
          link.textContent = 'Latest: ' + latest.dateLabel;
          run.parentNode.insertAdjacentElement('afterend', link);
        }
      })
      .catch(function () {});
  }

  // Most unusual: which list, ticker filter, show more, expand
  var PAGE = 10, shown = PAGE, view = 'top';
  var views = document.querySelectorAll('[data-view]');
  var lists = document.querySelectorAll('[data-list]');
  var tickerOnly = document.getElementById('ticker-only');
  var more = document.getElementById('show-more');
  var count = document.getElementById('ranked-count');
  var csv = document.getElementById('ranked-csv');
  function render() {
    var total = 0, visible = 0;
    lists.forEach(function (list) {
      var active = list.dataset.list === view;
      list.hidden = !active;
      if (!active) return;
      list.querySelectorAll('.pick').forEach(function (li) {
        var ok = !(tickerOnly && tickerOnly.checked && li.dataset.ticker === '0');
        if (ok) total++;
        li.hidden = !ok || total > shown;
        if (!li.hidden) visible++;
      });
      var empty = list.querySelector('.empty');
      if (empty) empty.hidden = total > 0;
    });
    if (count) count.textContent = total ? 'Showing ' + visible + ' of ' + total : '';
    if (more) more.hidden = visible >= total;
  }
  views.forEach(function (b) {
    b.addEventListener('click', function () {
      view = b.dataset.view; shown = PAGE;
      views.forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      if (csv) csv.dataset.csvSection = b.dataset.csv;
      render();
    });
  });
  if (tickerOnly) tickerOnly.addEventListener('change', function () { shown = PAGE; render(); });
  if (more) more.addEventListener('click', function () { shown += PAGE; render(); });
  document.querySelectorAll('.ranked').forEach(function (list) {
    list.addEventListener('click', function (e) {
      var b = e.target.closest('.more');
      if (!b) return;
      var li = b.closest('.pick');
      li.classList.toggle('open');
      b.setAttribute('aria-expanded', String(li.classList.contains('open')));
    });
  });
  render();

  // Every trade: purchases / sales
  var tabBtns = document.querySelectorAll('.tab-btn');
  var tabPanels = document.querySelectorAll('.tab-panel');
  function activateTab(id) {
    tabBtns.forEach(function (b) {
      b.classList.toggle('active', b.dataset.tab === id);
      b.setAttribute('aria-selected', String(b.dataset.tab === id));
    });
    tabPanels.forEach(function (p) { p.classList.toggle('active', p.id === id); });
    try { localStorage.setItem('congress-tab', id); } catch (e) {}
  }
  tabBtns.forEach(function (b) { b.addEventListener('click', function () { activateTab(b.dataset.tab); }); });
  var savedTab = null;
  try { savedTab = localStorage.getItem('congress-tab'); } catch (e) {}
  var firstTab = tabBtns.length ? tabBtns[0].dataset.tab : null;
  if (firstTab) activateTab(savedTab && document.getElementById(savedTab) ? savedTab : firstTab);
})();
`;

// ─────────────────────────────────────────────────────────────────────────────
// Report page
// ─────────────────────────────────────────────────────────────────────────────

/** One entry in the report picker and the new-disclosures chart. */
export interface ReportRunLink {
  label: string;      // "September 24, 2026"
  href: string;       // relative to this report
  date: string;       // ISO date of the run
  newTrades?: number; // absent for runs from before the count was recorded
}

export interface HtmlReportOptions {
  report: AnalysisReport;
  /** All sales trades (sorted by date descending) */
  salesTrades: Array<{ trade: FMPTrade; party: string | undefined }>;
  /** All purchase trades (sorted by date descending) */
  purchaseTrades: Array<{ trade: FMPTrade; party: string | undefined }>;
  /** Title date label: the date the report ran, e.g. "April 13, 2026" */
  dateLabel: string;
  /** Link back to the index page */
  indexUrl?: string;
  /** Symbol → FMP exchangeShortName, used to build TradingView chart links */
  exchangeMap?: Map<string, string>;
  /** URLs for generated party pages (relative to this report's location) */
  partyPageUrls?: { republican?: string; democrat?: string; independent?: string };
  /** Resolves a trade to its member page filename (relative to this report's location) */
  memberLink?: MemberLinker;
  /** ISO date (YYYY-MM-DD) used to name exported CSV files */
  dateStr?: string;
  /** How many days back from generation time to look when ranking Top Purchases / Committee-Relevant (default 30) */
  topWindowDays?: number;
  /** True for trades disclosed since the previous run; those rows are marked new. */
  isNewlyDisclosed?: (trade: FMPTrade) => boolean;
  /** Date label of the run the new disclosures are measured against; absent on the first run. */
  previousRunLabel?: string;
  /** Every run, newest first, including this one: feeds the picker and the chart. */
  runs?: ReportRunLink[];
}

const NUMBER_WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];
const numberWord = (n: number) => NUMBER_WORDS[n] ?? String(n);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const MAX_PER_FILER = 5;

function freshHtml(
  newly: Array<{ trade: FMPTrade; party: string | undefined }>,
  previousRunLabel: string | undefined,
  memberLink: MemberLinker | undefined,
): string {
  const since = previousRunLabel ? previousRunLabel.replace(/,\s*\d{4}$/, "") : "";
  if (!previousRunLabel) {
    return `<h1 id="fresh-h">This is the first report, so nothing is marked new yet.</h1>
      <p class="lede">The next run will list every trade disclosed after this one.</p>`;
  }
  if (!newly.length) {
    return `<h1 id="fresh-h">No new trades were disclosed since ${esc(since)}.</h1>
      <p class="lede">The most unusual purchases of the last month and every trade on file are below.</p>`;
  }

  const groups = new Map<string, { name: string; party: string | undefined; url: string | null; rows: typeof newly }>();
  for (const item of newly) {
    const name = `${item.trade.firstName ?? ""} ${item.trade.lastName ?? ""}`.trim();
    const url = memberLink?.(item.trade) ?? null;
    const key = url ?? name;
    if (!groups.has(key)) groups.set(key, { name, party: item.party, url, rows: [] });
    groups.get(key)!.rows.push(item);
  }
  const ordered = [...groups.values()]
    .map((g) => ({ ...g, rows: g.rows.sort((a, b) => (b.trade.transactionDate ?? "").localeCompare(a.trade.transactionDate ?? "")) }))
    .sort((a, b) => b.rows.length - a.rows.length || (b.rows[0].trade.transactionDate ?? "").localeCompare(a.rows[0].trade.transactionDate ?? ""));

  const sales = newly.filter((n) => sideLabel(n.trade.type) === "Sold").length;
  const buys = newly.length - sales;
  const oldest = newly.map((n) => n.trade.transactionDate).filter((d): d is string => !!d).sort()[0];
  const m = ordered.length;

  const filers = ordered.map((g) => {
    const shown = g.rows.slice(0, MAX_PER_FILER);
    const rest = g.rows.length - shown.length;
    return `
      <div class="filer">
        <h2>${g.url ? `<a href="${esc(g.url)}">${esc(g.name)}</a>` : esc(g.name)} ${partyTagHtml(g.party)}<span class="count">${plural(g.rows.length, "trade")}</span></h2>
        <ul class="filing-list">${shown.map(({ trade }) => {
          const side = sideLabel(trade.type);
          const phrase = trade.owner && trade.owner.toLowerCase() !== "self" ? ownerPhrase(trade.owner) : "";
          const owner = phrase ? `, ${phrase.charAt(0).toLowerCase()}${phrase.slice(1)}` : "";
          return `
          <li>
            <span class="side${side === "Sold" ? " sold" : ""}">${side}</span>
            <span class="what">${trade.symbol ? `<b>${esc(trade.symbol)}</b>` : ""}<span class="desc">${esc(tidyAsset(trade.assetDescription))}</span></span>
            <span class="size">${amountHtml(trade.amount)}</span>
            <span class="when">Traded ${esc(shortDate(trade.transactionDate, THIS_YEAR))}${esc(owner)}</span>
          </li>`;
        }).join("")}${rest > 0 ? `
          <li class="more-filed">${g.url ? `<a href="${esc(g.url)}">${plural(rest, "more trade")}</a>` : plural(rest, "more trade")} in this batch</li>` : ""}
        </ul>
      </div>`;
  }).join("");

  return `<h1 id="fresh-h">${numberWord(m)} ${m === 1 ? "member" : "members"} disclosed ${plural(newly.length, "trade")} since ${esc(since)}.</h1>
      <p class="lede">${plural(buys, "purchase")} and ${plural(sales, "sale")}.${oldest ? ` Trade dates run back to ${esc(shortDate(oldest, THIS_YEAR))}, because members have up to 45 days to report.` : ""}</p>
      <div class="filers">${filers}
      </div>`;
}

export function buildHtmlReport(opts: HtmlReportOptions): string {
  const {
    report, salesTrades, purchaseTrades, dateLabel, indexUrl,
    exchangeMap = new Map(),
    partyPageUrls,
    memberLink,
    dateStr = new Date(report.generatedAt).toISOString().split("T")[0],
    topWindowDays = 30,
    isNewlyDisclosed = () => false,
    previousRunLabel,
    runs = [],
  } = opts;

  const scoreLookup = buildScoreLookup(report);

  // Only rank trades from the last `topWindowDays` days (relative to report generation)
  // so the ranking stays current instead of surfacing the same all-time high scorers.
  const windowCutoff = new Date(report.generatedAt);
  windowCutoff.setDate(windowCutoff.getDate() - topWindowDays);
  const isWithinWindow = (t: AnalyzedTrade): boolean => {
    if (!t.trade.transactionDate) return false;
    const d = new Date(t.trade.transactionDate);
    return !isNaN(d.getTime()) && d >= windowCutoff;
  };

  const topPurchases = [...report.scoredTrades]
    .filter((t) => {
      const type = (t.trade.type || "").toLowerCase();
      return (type.includes("purchase") || type.includes("exchange")) && isWithinWindow(t);
    })
    .sort((a, b) => b.score.overallScore - a.score.overallScore)
    .slice(0, 30);

  const committeeRelevant = [...report.scoredTrades]
    .filter((t) => t.score.flags.hasCommitteeRelevance && isWithinWindow(t))
    .sort((a, b) => b.score.overallScore - a.score.overallScore)
    .slice(0, 20);

  const newly = [...purchaseTrades, ...salesTrades].filter(({ trade }) => isNewlyDisclosed(trade));

  const csvSections = {
    "top-purchases": { filename: `top-purchases-${dateStr}.csv`, csv: buildCsv(CARD_CSV_HEADERS, topPurchases.map(cardCsvRow)) },
    "committee-relevant": { filename: `committee-relevant-${dateStr}.csv`, csv: buildCsv(CARD_CSV_HEADERS, committeeRelevant.map(cardCsvRow)) },
    "recent-purchases": { filename: `recent-purchases-${dateStr}.csv`, csv: buildCsv(SALE_CSV_HEADERS, purchaseTrades.map(({ trade, party }) => saleCsvRow(trade, party, scoreLookup.get(tradeKey(trade))))) },
    "recent-sales": { filename: `recent-sales-${dateStr}.csv`, csv: buildCsv(SALE_CSV_HEADERS, salesTrades.map(({ trade, party }) => saleCsvRow(trade, party, scoreLookup.get(tradeKey(trade))))) },
  };

  const dates = report.scoredTrades.map((t) => t.trade.transactionDate).filter((d): d is string => !!d).sort();

  const picker = runs.length
    ? `<label class="run">Report for <select id="run" data-date="${esc(dateStr)}">${runs.map((r) =>
        `<option value="${esc(r.href)}"${r.date === dateStr ? " selected" : ""}>${esc(r.label)}${r.newTrades ? ` (${r.newTrades} new)` : ""}</option>`).join("")}</select></label>`
    : `<span class="run">Report for ${esc(dateLabel)}</span>`;

  const chartRuns = runs.filter((r) => r.newTrades != null).slice(0, 14).reverse();
  const maxNew = Math.max(1, ...chartRuns.map((r) => r.newTrades ?? 0));
  const chart = chartRuns.length > 1 ? `
    <div>
      <h2>New disclosures per report</h2>
      <div class="runs" style="grid-template-columns: repeat(${chartRuns.length}, 1fr)">${chartRuns.map((r) => `
        <a href="${esc(r.href)}"${r.date === dateStr ? ' aria-current="page"' : ""} title="${esc(r.label)}: ${plural(r.newTrades ?? 0, "new trade")}">
          <span class="bar" style="height:${(((r.newTrades ?? 0) / maxNew) * 5.5).toFixed(2)}rem"></span><span class="d">${esc(shortDate(r.date))}</span>
        </a>`).join("")}
      </div>
      <p class="runs-note">Each bar is one report. Taller means more trades were disclosed since the report before it. Select one to open it.</p>
    </div>` : "";

  const parties = [
    partyPageUrls?.republican ? `<li><a href="${esc(partyPageUrls.republican)}"><span>Republicans</span><span class="n"></span></a></li>` : "",
    partyPageUrls?.democrat ? `<li><a href="${esc(partyPageUrls.democrat)}"><span>Democrats</span><span class="n"></span></a></li>` : "",
    partyPageUrls?.independent ? `<li><a href="${esc(partyPageUrls.independent)}"><span>Independents</span><span class="n"></span></a></li>` : "",
    indexUrl ? `<li><a href="${esc(indexUrl)}"><span>All past reports</span><span class="n">${runs.length || ""}</span></a></li>` : "",
  ].join("");

  const rankedList = (key: string, list: AnalyzedTrade[], emptyText: string) => `
      <ol class="ranked" data-list="${key}"${key === "top" ? "" : " hidden"}>${list.map((t, i) => renderPick(t, `pick-${key}-${i}`, exchangeMap, memberLink)).join("")}
        <li class="empty"${list.length ? " hidden" : ""}>${emptyText}</li>
      </ol>`;

  return `<!DOCTYPE html>
${HTML_OPEN}
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Outlier Caucus, ${esc(dateLabel)}</title>
  ${themeHead(REPORT_CSS, "../")}
</head>
<body>

${siteHeader(indexUrl ?? "#", picker)}

<main>
  <section class="fresh-band" aria-labelledby="fresh-h">
    <div class="wrap fresh">
      ${freshHtml(newly, previousRunLabel, memberLink)}
    </div>
  </section>

  <section class="unusual" id="unusual" aria-labelledby="unusual-h">
    <div class="wrap">
      <div class="band-head">
        <div>
          <h2 id="unusual-h">Most unusual purchases</h2>
          <p>Trades from the last ${topWindowDays} days, ranked by how far they sit from what Congress usually buys: rarely traded stocks, bigger than the member's normal size, or in an industry their committee oversees.</p>
        </div>
        <div class="views">
          <span class="seg" role="group" aria-label="Which trades">
            <button type="button" data-view="top" data-csv="top-purchases" aria-pressed="true">All purchases</button>
            <button type="button" data-view="committee" data-csv="committee-relevant" aria-pressed="false">Committee overlap</button>
          </span>
          <label class="check"><input type="checkbox" id="ticker-only"> Only trades with a ticker</label>
          <button class="csv-btn" type="button" id="ranked-csv" data-csv-section="top-purchases">Download CSV</button>
        </div>
      </div>
      ${rankedList("top", topPurchases, `No purchases in the last ${topWindowDays} days scored high enough to rank.`)}
      ${rankedList("committee", committeeRelevant, `No trades in the last ${topWindowDays} days fall under the member's own committees.`)}
      <div class="ranked-foot"><span id="ranked-count"></span><button type="button" id="show-more">Show 10 more</button></div>
    </div>
  </section>

  <section class="every" id="every" aria-labelledby="every-h">
    <div class="wrap">
      <div class="band-head">
        <div>
          <h2 id="every-h">Every trade</h2>
          <p>All ${report.totalTradesAnalyzed.toLocaleString("en-US")} disclosed trades from ${esc(shortDate(dates[0], "any"))} to ${esc(shortDate(dates[dates.length - 1], "any"))}, newest trade first.${newly.length ? " Trades disclosed since the last report are marked new." : ""}</p>
        </div>
        <span class="seg" role="tablist" aria-label="Purchases or sales">
          <button class="tab-btn" type="button" role="tab" data-tab="tab-purchases">Purchases ${purchaseTrades.length.toLocaleString("en-US")}</button>
          <button class="tab-btn" type="button" role="tab" data-tab="tab-sales">Sales ${salesTrades.length.toLocaleString("en-US")}</button>
        </span>
      </div>
      <div class="tab-panel" id="tab-purchases" role="tabpanel">
        <section class="section" id="recent-purchases">
          <div class="section-header">
            ${csvButtonHtml("recent-purchases")}
          </div>
          ${tradeTableHtml(purchaseTrades, exchangeMap, memberLink, scoreLookup, isNewlyDisclosed)}
        </section>
      </div>
      <div class="tab-panel" id="tab-sales" role="tabpanel">
        <section class="section" id="recent-sales">
          <div class="section-header">
            ${csvButtonHtml("recent-sales")}
          </div>
          ${tradeTableHtml(salesTrades, exchangeMap, memberLink, scoreLookup, isNewlyDisclosed)}
        </section>
      </div>
    </div>
  </section>

  <section class="rest" aria-label="More">
    <div class="wrap elsewhere">
      <div>
        <h2>Browse</h2>
        <ul class="browse">${parties}</ul>
      </div>
      ${chart}
    </div>
  </section>
</main>

<footer>
  Scores measure how unusual a trade is, not whether it is a good investment. Not investment advice.
</footer>

${csvDataScript(csvSections)}
<script>${THEME_JS}</script>
<script>${REPORT_JS}</script>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Member and party pages
// ─────────────────────────────────────────────────────────────────────────────

const LIST_PAGE_CSS = `
  .list-page .section { padding-top: 2rem; }
`;

function listPage(opts: {
  title: string;
  headingHtml: string;
  statsHtml: string;
  crumbsHtml: string;
  homeHref: string;
  sectionsHtml: string;
  csvSections: Record<string, { filename: string; csv: string }>;
}): string {
  return `<!DOCTYPE html>
${HTML_OPEN}
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${opts.title}</title>
  ${themeHead(LIST_PAGE_CSS, "../")}
</head>
<body class="list-page">
${siteHeader(opts.homeHref, `<nav class="crumbs" aria-label="Back">${opts.crumbsHtml}</nav>`)}
<main>
  <div class="page-head-band">
    <div class="wrap page-head">
      <h1 class="site-title">${opts.headingHtml}</h1>
      <div class="stats-bar">${opts.statsHtml}</div>
    </div>
  </div>
  <div class="wrap">
    ${opts.sectionsHtml}
  </div>
</main>
<footer>
  Scores measure how unusual a trade is, not whether it is a good investment. Not investment advice.
</footer>
${csvDataScript(opts.csvSections)}
<script>${THEME_JS}</script>
</body>
</html>`;
}

function crumbs(indexUrl: string | undefined, reportUrl: string, dateLabel: string): string {
  return [
    `<a href="${esc(reportUrl)}">Report for ${esc(dateLabel)}</a>`,
    indexUrl ? `<a href="${esc(indexUrl)}">All reports</a>` : "",
  ].filter(Boolean).join("");
}

export interface MemberPageOptions {
  memberName: string;
  /** Page slug from the member resolver, so CSV names match the page file */
  memberSlug?: string;
  chamber: string; // "Sen." | "Rep."
  party: string | undefined;
  trades: Array<{ trade: FMPTrade; party: string | undefined }>;
  dateLabel: string;
  reportUrl: string;
  indexUrl?: string;
  exchangeMap?: Map<string, string>;
  memberLink?: MemberLinker;
  scoreLookup?: Map<string, AnalyzedTrade>;
  dateStr?: string;
}

export function buildMemberPage(opts: MemberPageOptions): string {
  const {
    memberName, chamber, party, trades, dateLabel, reportUrl, indexUrl,
    exchangeMap = new Map(), scoreLookup,
    dateStr = new Date().toISOString().split("T")[0],
  } = opts;

  const purchases = trades.filter((t) => { const ty = (t.trade.type || "").toLowerCase(); return ty.includes("purchase") || ty.includes("exchange"); });
  const sales = trades.filter((t) => (t.trade.type || "").toLowerCase().includes("sale"));
  const memberSlug = opts.memberSlug ?? memberKey(memberName);

  const csvSections = {
    [`${memberSlug}-purchases`]: { filename: `${memberSlug}-purchases-${dateStr}.csv`, csv: buildCsv(SALE_CSV_HEADERS, purchases.map(({ trade, party: p }) => saleCsvRow(trade, p, scoreLookup?.get(tradeKey(trade))))) },
    [`${memberSlug}-sales`]: { filename: `${memberSlug}-sales-${dateStr}.csv`, csv: buildCsv(SALE_CSV_HEADERS, sales.map(({ trade, party: p }) => saleCsvRow(trade, p, scoreLookup?.get(tradeKey(trade))))) },
  };

  function table(rows: typeof trades, title: string, id: string, csvKey: string): string {
    if (!rows.length) return "";
    return `
  <section class="section" id="${id}">
    <div class="section-header">
      <h2 class="section-title">${esc(title)}</h2>
      <span class="section-count">${plural(rows.length, "trade")}</span>
      ${csvButtonHtml(csvKey)}
    </div>
    <div class="sales-table-wrap">
      <table>
        <thead><tr><th>Traded</th><th>Ticker</th><th>Amount</th><th>Asset</th></tr></thead>
        <tbody>
          ${rows.map(({ trade }) => {
            const owner = trade.owner && trade.owner.toLowerCase() !== "self" ? trade.owner : "";
            const analyzed = scoreLookup?.get(tradeKey(trade));
            const signals = [analyzed ? traderBadgesHtml(analyzed.score) : "", optionTagHtml(trade), owner ? `<span class="owner-tag" title="${esc(ownerCode(owner).title)}">${esc(owner)}</span>` : ""].filter(Boolean).join(" ");
            const filingLink = filingLinkHtml(trade);
            return `
          <tr>
            <td class="sale-date">${esc(shortDate(trade.transactionDate, THIS_YEAR))}</td>
            <td class="sale-sym">${symbolHtml(trade, exchangeMap)}</td>
            <td class="sale-amount">${amountHtml(trade.amount)}</td>
            <td class="sale-desc">${esc(tidyAsset(trade.assetDescription))}${signals ? ` ${signals}` : ""}${filingLink ? ` ${filingLink}` : ""}</td>
          </tr>`;
          }).join("")}
        </tbody>
      </table>
    </div>
  </section>`;
  }

  return listPage({
    title: `${esc(chamber)} ${esc(memberName)}, ${esc(dateLabel)}`,
    headingHtml: `${esc(chamber)} ${esc(memberName)} ${partyTagHtml(party)}`,
    statsHtml: `<span><strong>${purchases.length}</strong> purchases</span><span><strong>${sales.length}</strong> sales</span><span><strong>${trades.length}</strong> total</span>`,
    crumbsHtml: crumbs(indexUrl, reportUrl, dateLabel),
    homeHref: indexUrl ?? reportUrl,
    sectionsHtml: table(purchases, "Purchases", "purchases", `${memberSlug}-purchases`) + table(sales, "Sales", "sales", `${memberSlug}-sales`),
    csvSections,
  });
}

export interface PartyPageOptions {
  partyLabel: string; // "Republican" | "Democrat" | "Independent"
  trades: Array<{ trade: FMPTrade; party: string | undefined }>;
  dateLabel: string;
  reportUrl: string;
  indexUrl?: string;
  exchangeMap?: Map<string, string>;
  memberLink?: MemberLinker;
  scoreLookup?: Map<string, AnalyzedTrade>;
  dateStr?: string;
}

export function buildPartyPage(opts: PartyPageOptions): string {
  const {
    partyLabel: label, trades, dateLabel, reportUrl, indexUrl,
    exchangeMap = new Map(), memberLink, scoreLookup,
    dateStr = new Date().toISOString().split("T")[0],
  } = opts;

  const purchases = trades.filter((t) => { const ty = (t.trade.type || "").toLowerCase(); return ty.includes("purchase") || ty.includes("exchange"); });
  const sales = trades.filter((t) => (t.trade.type || "").toLowerCase().includes("sale"));

  const partySlug = label.toLowerCase();
  const csvSections = {
    [`${partySlug}-purchases`]: { filename: `${partySlug}-purchases-${dateStr}.csv`, csv: buildCsv(SALE_CSV_HEADERS, purchases.map(({ trade, party }) => saleCsvRow(trade, party, scoreLookup?.get(tradeKey(trade))))) },
    [`${partySlug}-sales`]: { filename: `${partySlug}-sales-${dateStr}.csv`, csv: buildCsv(SALE_CSV_HEADERS, sales.map(({ trade, party }) => saleCsvRow(trade, party, scoreLookup?.get(tradeKey(trade))))) },
  };

  function table(rows: typeof trades, title: string, id: string, csvKey: string): string {
    if (!rows.length) return "";
    return `
  <section class="section" id="${id}">
    <div class="section-header">
      <h2 class="section-title">${esc(title)}</h2>
      <span class="section-count">${plural(rows.length, "trade")}</span>
      ${csvButtonHtml(csvKey)}
    </div>
    ${tradeTableHtml(rows, exchangeMap, memberLink, scoreLookup)}
  </section>`;
  }

  return listPage({
    title: `${esc(label)} trades, ${esc(dateLabel)}`,
    headingHtml: `${esc(label)} trades`,
    statsHtml: `<span><strong>${purchases.length.toLocaleString("en-US")}</strong> purchases</span><span><strong>${sales.length.toLocaleString("en-US")}</strong> sales</span><span><strong>${trades.length.toLocaleString("en-US")}</strong> total</span>`,
    crumbsHtml: crumbs(indexUrl, reportUrl, dateLabel),
    homeHref: indexUrl ?? reportUrl,
    sectionsHtml: table(purchases, "Purchases", "purchases", `${partySlug}-purchases`) + table(sales, "Sales", "sales", `${partySlug}-sales`),
    csvSections,
  });
}
