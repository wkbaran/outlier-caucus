import * as fs from "fs/promises";
import * as path from "path";
import { HTML_OPEN, THEME_JS, themeHead, siteHeader } from "./theme.js";

/** A chip on the archive page: one newly disclosed trade's symbol and side. */
export interface ManifestSymbol {
  symbol: string;
  side: "purchase" | "sale";
}

export interface ReportManifestEntry {
  date: string;        // ISO date string, e.g. "2026-04-18"
  dateLabel: string;   // Human-readable date the report ran, e.g. "April 13, 2026"
  file: string;        // Relative filename, e.g. "report-2026-04-18.html"
  totalTrades: number;
  topSymbols: string[]; // Legacy preview (pre-newSymbols runs); kept so old entries still render
  /** Symbols newly disclosed in this run, with side, for colored chips. */
  newSymbols?: ManifestSymbol[];
  /** How many trades this run disclosed that the previous run had not seen. */
  newTrades?: number;
  /** High-water filing date for this run — the next run's "what is new" baseline. */
  maxFilingDate?: string;
}

/**
 * The filing high-water mark to treat as "already seen" when building a report
 * for `date`. Takes the max across all *earlier* runs rather than just the
 * latest one, so a partial or failed run cannot roll the baseline backwards and
 * re-flag trades that were already shown as new.
 */
export function previousFilingBaseline(
  manifest: ReportManifestEntry[],
  date: string
): string | null {
  let max: string | null = null;
  for (const entry of manifest) {
    if (entry.date >= date) continue;
    const seen = entry.maxFilingDate;
    if (seen && (max === null || seen > max)) max = seen;
  }
  return max;
}

const MANIFEST_FILE = "manifest.json";

// ─────────────────────────────────────────────────────────────────────────────
// Manifest helpers
// ─────────────────────────────────────────────────────────────────────────────

export async function loadManifest(webDir: string): Promise<ReportManifestEntry[]> {
  const manifestPath = path.join(webDir, MANIFEST_FILE);
  try {
    const raw = await fs.readFile(manifestPath, "utf-8");
    return JSON.parse(raw) as ReportManifestEntry[];
  } catch {
    return [];
  }
}

async function writeManifest(webDir: string, entries: ReportManifestEntry[]): Promise<void> {
  await fs.writeFile(
    path.join(webDir, MANIFEST_FILE),
    JSON.stringify(entries, null, 2)
  );
}

/**
 * Remove manifest entries whose HTML files no longer exist on disk.
 */
async function pruneManifest(
  webDir: string,
  manifest: ReportManifestEntry[]
): Promise<ReportManifestEntry[]> {
  const live: ReportManifestEntry[] = [];
  for (const entry of manifest) {
    try {
      await fs.access(path.join(webDir, entry.file));
      live.push(entry);
    } catch {
      console.log(`   Pruned stale manifest entry: ${entry.file}`);
    }
  }
  return live;
}

/**
 * Insert or update a manifest entry, prune deleted files, sort newest first.
 * Returns the updated manifest.
 */
export async function upsertManifest(
  webDir: string,
  entry: ReportManifestEntry
): Promise<ReportManifestEntry[]> {
  let manifest = await loadManifest(webDir);

  // Upsert
  const idx = manifest.findIndex((e) => e.date === entry.date);
  if (idx >= 0) manifest[idx] = entry;
  else manifest.unshift(entry);

  // Prune then sort
  manifest = await pruneManifest(webDir, manifest);
  manifest.sort((a, b) => b.date.localeCompare(a.date));

  await writeManifest(webDir, manifest);
  return manifest;
}

/**
 * Rebuild the manifest by scanning for existing report HTML files.
 * Removes entries whose files are gone; keeps metadata for those that remain.
 */
export async function rebuildManifest(webDir: string): Promise<ReportManifestEntry[]> {
  const manifest = await loadManifest(webDir);
  const pruned = await pruneManifest(webDir, manifest);
  pruned.sort((a, b) => b.date.localeCompare(a.date));
  await writeManifest(webDir, pruned);
  return pruned;
}

// ─────────────────────────────────────────────────────────────────────────────
// Index page
// ─────────────────────────────────────────────────────────────────────────────

const INDEX_CSS = `
  .report-list { list-style: none; padding: 0; border-top: 1px solid var(--line); }
  .report-item { display: grid; grid-template-columns: 12rem 1fr auto; gap: 0.3rem 1.5rem; align-items: baseline; padding: 0.9rem 0; border-bottom: 1px solid var(--line); }
  .report-date a { font-weight: 600; text-decoration: none; }
  .report-date a:hover { text-decoration: underline; text-decoration-color: var(--signal); }
  .report-count { color: var(--sub); font-size: 0.92rem; }
  .report-new { color: var(--ink); font-weight: 600; }
  .report-new::before { content: ""; display: inline-block; width: 0.45rem; height: 0.45rem; border-radius: 50%; background: var(--signal); margin-right: 0.4rem; vertical-align: 1px; }
  .report-chips { display: flex; flex-wrap: wrap; gap: 0.3rem; justify-content: end; }
  .chip { font-size: 0.8rem; font-weight: 600; padding: 0 0.35rem; border: 1px solid var(--line-strong); border-radius: 4px; }
  /* Sales are muted so a run's disclosures can be skimmed by side at a glance. */
  .chip-sale { font-weight: 400; color: var(--muted); border-color: var(--line); }
  .legend { margin-top: 0.75rem; font-size: 0.85rem; color: var(--muted); }
  .legend .chip { font-size: 0.75rem; }
  .empty-msg { color: var(--sub); padding: 1rem 0; }
  @media (max-width: 640px) {
    .report-item { grid-template-columns: 1fr auto; }
    .report-chips { grid-column: 1 / 3; justify-content: start; }
  }
`;

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildIndexPage(entries: ReportManifestEntry[]): string {
  const rows = entries.map((e) => {
    // Runs from before newSymbols existed carry only the legacy flat list;
    // render those uncolored rather than inventing a side we never recorded.
    const colorize = !!e.newSymbols;
    const chipSource: ManifestSymbol[] = e.newSymbols
      ?? e.topSymbols.map((symbol) => ({ symbol, side: "purchase" as const }));

    const chips = chipSource
      .slice(0, 6)
      .map((c) => {
        const cls = colorize && c.side === "sale" ? "chip chip-sale" : "chip";
        const title = colorize ? ` title="${c.side === "sale" ? "Sold" : "Bought"}"` : "";
        return `<span class="${cls}"${title}>${escHtml(c.symbol)}</span>`;
      })
      .join("");

    const count = e.newTrades && e.newTrades > 0
      ? `<span class="report-new">${e.newTrades} new</span>, ${e.totalTrades.toLocaleString("en-US")} on file`
      : `${e.totalTrades.toLocaleString("en-US")} trades`;

    return `
    <li class="report-item">
      <span class="report-date report-link"><a href="${escHtml(e.file)}">${escHtml(e.dateLabel)}</a></span>
      <span class="report-count">${count}</span>
      <span class="report-chips">${chips}</span>
    </li>`;
  });

  const emptyMsg = `<p class="empty-msg">No reports yet. Run <code>outlier-caucus report:html</code> to generate the first one.</p>`;
  const latest = entries[0];

  return `<!DOCTYPE html>
${HTML_OPEN}
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Outlier Caucus</title>
  ${themeHead(INDEX_CSS)}
</head>
<body>

${siteHeader("archive.html", latest ? `<nav class="crumbs"><a href="${escHtml(latest.file)}">Latest report</a></nav>` : "")}

<main>
  <div class="page-head-band">
    <div class="wrap page-head">
      <h1>Reports</h1>
      <p>Each report ranks the most unusual stock trades members of Congress disclosed, and marks what is new since the report before it.</p>
      ${entries.some((e) => e.newSymbols) ? `<p class="legend">Tickers are this run's new disclosures: <span class="chip">Bought</span> <span class="chip chip-sale">Sold</span></p>` : ""}
    </div>
  </div>
  <div class="wrap">
    ${entries.length ? `<ul class="report-list">${rows.join("")}</ul>` : emptyMsg}
  </div>
</main>

<footer>
  Not investment advice.
</footer>

<script>${THEME_JS}</script>
</body>
</html>`;
}

/**
 * The site root: forwards to the newest report. The meta refresh covers
 * browsers without JavaScript; replace() keeps the hop out of history.
 * With no reports yet it falls back to the (empty) archive.
 */
export function buildHomePage(entries: ReportManifestEntry[]): string {
  const target = entries[0]?.file ?? "archive.html";
  const href = escHtml(target);
  return `<!DOCTYPE html>
${HTML_OPEN}
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Outlier Caucus</title>
  <meta http-equiv="refresh" content="0; url=${href}">
  <link rel="canonical" href="${href}">
  <script>location.replace(${JSON.stringify(target).replace(/</g, "\\u003c")});</script>
  ${themeHead()}
</head>
<body>
  <main class="wrap page-head">
    <p>Opening the <a href="${href}">latest report</a>. See <a href="archive.html">all reports</a>.</p>
  </main>
</body>
</html>`;
}
