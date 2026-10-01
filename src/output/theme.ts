/**
 * Shared look for every generated page: the palette picker (ported from
 * equity-watch's web/palette.js), light/dark switch, fonts, base tokens,
 * header and trade tables.
 *
 * The stylesheet reads three custom properties off <html>: --p-ground (the
 * background in dark mode), --p-ink (the text in dark mode) and --p-signal
 * (the one accent). Every other colour is mixed from those, and light mode
 * swaps ground and ink, so a palette is a complete theme. The accent is spent
 * on what is new and on scores; everything else stays in ink.
 */

/** "Ink and violet": the site's default palette (ground, ink, signal). */
export const DEFAULT_PALETTE = ["#15162b", "#e6e4f5", "#b69bff"] as const;

/**
 * The favicon: a Capitol dome in the accent over a colonnade in ink, on the
 * ground. {g}, {i} and {s} take the palette's three colours, so the tab icon
 * follows the picker like the rest of the page.
 */
export const FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
  '<rect width="32" height="32" rx="7" fill="{g}"/>' +
  '<rect x="15" y="4" width="2" height="4" rx="1" fill="{s}"/>' +
  '<path d="M8 16a8 8 0 0 1 16 0z" fill="{s}"/>' +
  '<path d="M9 17.5h14v6H9zM6 25h20v3H6z" fill="{i}"/>' +
  '<path d="M11.4 19h1.4v4.5h-1.4zM15.3 19h1.4v4.5h-1.4zM19.2 19h1.4v4.5h-1.4z" fill="{g}"/>' +
  "</svg>";

/** The favicon in one palette. iOS rounds home-screen icons itself, so the Apple icon asks for square corners. */
export function faviconSvg(colors: readonly string[], square = false): string {
  const svg = FAVICON_SVG.replace(/\{g\}/g, colors[0]).replace(/\{i\}/g, colors[1]).replace(/\{s\}/g, colors[2]);
  return square ? svg.replace(' rx="7"', "") : svg;
}

const FONT_HREF =
  "https://fonts.googleapis.com/css2?family=Instrument+Sans:wdth,wght@75..100,400..700&display=swap";

/** Runs in <head> before first paint so the page never flashes the wrong theme or palette. */
const PALETTE_JS = `
(function () {
  var KEY = "congress-trades.palette";
  var root = document.documentElement;
  var ICON = ${JSON.stringify(FAVICON_SVG)};
  try { if (localStorage.getItem("congress-theme") === "light") root.setAttribute("data-theme", "light"); } catch (e) {}
  var PRESETS = [
    { name: "Ink and violet", colors: ["#15162b", "#e6e4f5", "#b69bff"] },
    { name: "Petrol and sodium", colors: ["#0e2a31", "#ece4d0", "#f3a83b"] },
    { name: "Walnut and cyan", colors: ["#241a12", "#f2e8d3", "#57c7f5"] },
    { name: "Oxblood and brass", colors: ["#2b1016", "#f1e2de", "#e6c160"] },
    { name: "Moss and coral", colors: ["#15201a", "#e2ecdc", "#ff8a66"] },
    { name: "Carbon and signal red", colors: ["#1a1b1d", "#ecebe6", "#ff5a4e"] }
  ];
  var defaults = (root.getAttribute("data-palette") || "").split(",").filter(Boolean);
  if (defaults.length !== 3) defaults = PRESETS[0].colors;
  function read() {
    try {
      var saved = JSON.parse(localStorage.getItem(KEY) || "null");
      if (Array.isArray(saved) && saved.length === 3) return saved;
    } catch (e) {}
    return defaults;
  }
  function apply(c) {
    root.style.setProperty("--p-ground", c[0]);
    root.style.setProperty("--p-ink", c[1]);
    root.style.setProperty("--p-signal", c[2]);
    var icon = document.getElementById("favicon");
    if (icon) icon.setAttribute("href", "data:image/svg+xml," + encodeURIComponent(
      ICON.replace(/\{g\}/g, c[0]).replace(/\{i\}/g, c[1]).replace(/\{s\}/g, c[2])));
  }
  function save(c) { try { localStorage.setItem(KEY, JSON.stringify(c)); } catch (e) {} }
  var colors = read();
  apply(colors);

  function el(tag, props) {
    var node = document.createElement(tag);
    for (var k in props) {
      if (k === "text") node.textContent = props[k];
      else if (k.slice(0, 2) === "on") node.addEventListener(k.slice(2), props[k]);
      else node.setAttribute(k, props[k]);
    }
    for (var i = 2; i < arguments.length; i++) node.append(arguments[i]);
    return node;
  }
  function swatches(list) { return list.map(function (c) { return el("span", { style: "background:" + c }); }); }

  function buildPanel() {
    var code = el("code", { "class": "pal-code", text: colors.join(", ") });
    var inputs = ["Background", "Text", "Accent"].map(function (label, i) {
      var input = el("input", { type: "color", id: "pal-" + i, value: colors[i] });
      input.addEventListener("input", function () {
        colors = colors.map(function (c, j) { return j === i ? input.value : c; });
        apply(colors); save(colors); code.textContent = colors.join(", ");
      });
      return { input: input, row: el("div", { "class": "pal-field" }, input, el("label", { "for": "pal-" + i, text: label })) };
    });
    function sync() {
      inputs.forEach(function (x, i) { x.input.value = colors[i]; });
      code.textContent = colors.join(", ");
    }
    var presets = el.apply(null, ["div", { "class": "pal-presets" }].concat(PRESETS.map(function (p) {
      return el.apply(null, ["button", {
        type: "button", "class": "pal-preset", title: p.name, "aria-label": "Use " + p.name,
        onclick: function () { colors = p.colors.slice(); apply(colors); save(colors); sync(); }
      }].concat(swatches(p.colors)));
    })));
    var reset = el("button", {
      type: "button", "class": "pal-reset", text: "Reset to the default",
      onclick: function () {
        colors = defaults.slice(); apply(colors);
        try { localStorage.removeItem(KEY); } catch (e) {}
        sync();
      }
    });
    var panel = el.apply(null, ["div", { "class": "pal-panel", id: "pal-panel", role: "dialog", "aria-label": "Palette", hidden: "" },
      el("div", { "class": "pal-heading", text: "Palette" }), presets]
      .concat(inputs.map(function (x) { return x.row; })).concat([code, reset]));
    var toggle = el.apply(null, ["button", {
      type: "button", "class": "pal-toggle", "aria-expanded": "false", "aria-controls": "pal-panel", "aria-label": "Palette",
      onclick: function () { panel.hidden = !panel.hidden; toggle.setAttribute("aria-expanded", String(!panel.hidden)); }
    }].concat(swatches(["var(--p-ground)", "var(--p-ink)", "var(--p-signal)"])));
    var box = el("div", { "class": "pal" }, panel, toggle);
    function close() { panel.hidden = true; toggle.setAttribute("aria-expanded", "false"); }
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !panel.hidden) close(); });
    document.addEventListener("pointerdown", function (e) { if (!panel.hidden && !box.contains(e.target)) close(); });
    document.body.append(box);
  }
  document.addEventListener("DOMContentLoaded", buildPanel);
})();
`;

/** Light/dark button and CSV export, shared by every page. */
export const THEME_JS = `
(function () {
  var root = document.documentElement;
  var btn = document.getElementById('theme-btn');
  function updateLabel() {
    if (btn) btn.textContent = root.getAttribute('data-theme') === 'light' ? 'Dark mode' : 'Light mode';
  }
  updateLabel();
  if (btn) {
    btn.addEventListener('click', function () {
      var next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem('congress-theme', next); } catch (e) {}
      updateLabel();
    });
  }

  var csvDataEl = document.getElementById('csv-data');
  var csvData = null;
  if (csvDataEl) { try { csvData = JSON.parse(csvDataEl.textContent); } catch (e) { csvData = null; } }
  document.querySelectorAll('[data-csv-section]').forEach(function (b) {
    b.addEventListener('click', function () {
      var entry = csvData && csvData[b.dataset.csvSection];
      if (!entry) return;
      var url = URL.createObjectURL(new Blob([entry.csv], { type: 'text/csv;charset=utf-8;' }));
      var a = document.createElement('a');
      a.href = url; a.download = entry.filename;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    });
  });
})();
`;

/**
 * Everything a page needs in <head> after its <title>. `root` is the path back
 * to the site root ("../" from a dated report folder), where the static icons live.
 */
export function themeHead(extraCss = "", root = ""): string {
  return `<link rel="icon" id="favicon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(faviconSvg(DEFAULT_PALETTE))}">
  <link rel="apple-touch-icon" href="${root}apple-touch-icon.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="${FONT_HREF}">
  <script>${PALETTE_JS}</script>
  <style>${BASE_CSS}${extraCss}</style>`;
}

/** Opening <html> tag carrying the default palette the picker resets to. */
export const HTML_OPEN = `<html lang="en" data-theme="dark" data-palette="${DEFAULT_PALETTE.join(",")}">`;

export const BASE_CSS = `
  :root { --ground: var(--p-ground, ${DEFAULT_PALETTE[0]}); --ink: var(--p-ink, ${DEFAULT_PALETTE[1]}); --signal: var(--p-signal, ${DEFAULT_PALETTE[2]}); color-scheme: dark; }
  :root[data-theme="light"] {
    --ground: var(--p-ink, ${DEFAULT_PALETTE[1]}); --ink: var(--p-ground, ${DEFAULT_PALETTE[0]});
    --signal: color-mix(in oklab, var(--p-signal, ${DEFAULT_PALETTE[2]}) 62%, var(--p-ground, ${DEFAULT_PALETTE[0]}));
    color-scheme: light;
  }
  :root {
    --surface: color-mix(in oklab, var(--ink) 5%, var(--ground));
    --raised: color-mix(in oklab, var(--ink) 9%, var(--ground));
    --line: color-mix(in oklab, var(--ink) 14%, var(--ground));
    --line-strong: color-mix(in oklab, var(--ink) 28%, var(--ground));
    --muted: color-mix(in oklab, var(--ink) 55%, var(--ground));
    --sub: color-mix(in oklab, var(--ink) 75%, var(--ground));
    --wash: color-mix(in oklab, var(--signal) 12%, var(--ground));
    --rep: color-mix(in oklab, #e0524f 78%, var(--ink));
    --dem: color-mix(in oklab, #4d84e8 78%, var(--ink));
    --shadow: 0 18px 48px color-mix(in oklab, black 45%, transparent);
    --measure: 72rem;
  }
  *, *::before, *::after { box-sizing: border-box; }
  html { font-size: 16px; }
  body {
    margin: 0; min-height: 100vh; background: var(--ground); color: var(--ink);
    font-family: "Instrument Sans", system-ui, sans-serif; line-height: 1.5;
    font-variant-numeric: tabular-nums; -webkit-font-smoothing: antialiased;
  }
  a { color: inherit; text-decoration: underline; text-decoration-color: var(--line-strong); text-underline-offset: 3px; }
  a:hover { text-decoration-color: var(--signal); }
  :focus-visible { outline: 2px solid var(--signal); outline-offset: 2px; border-radius: 2px; }
  button { font: inherit; color: var(--ink); cursor: pointer; }
  h1, h2, h3, p, ul, ol { margin: 0; }
  .wrap { max-width: var(--measure); margin: 0 auto; padding-left: 1.5rem; padding-right: 1.5rem; }

  /* ---- masthead ---- */
  .top { display: flex; align-items: center; flex-wrap: wrap; gap: 0.5rem 1.25rem; padding-top: 1.1rem; padding-bottom: 1.1rem; }
  .brand { font-weight: 700; font-size: 1.05rem; letter-spacing: -0.01em; text-decoration: none; display: flex; align-items: center; gap: 0.55rem; }
  /* The mark: a gavel's head resting on a price line. */
  .brand::before { content: ""; width: 1.25rem; height: 0.9rem; flex: none; background:
    linear-gradient(var(--signal), var(--signal)) 0 100% / 100% 2px no-repeat,
    linear-gradient(var(--ink), var(--ink)) 30% 0 / 0.7rem 0.45rem no-repeat; }
  .crumbs { display: flex; gap: 1rem; font-size: 0.9rem; color: var(--sub); }
  .run { color: var(--sub); font-size: 0.9rem; }
  /* Options get their own colours: left transparent, Windows draws them white. */
  .run select {
    font: inherit; color: var(--ink); background: var(--ground); border: 1px solid var(--line-strong);
    border-radius: 6px; padding: 0.2rem 0.4rem; margin-left: 0.25rem;
  }
  .run select option { background: var(--raised); color: var(--ink); }
  .run-latest { font-size: 0.9rem; font-weight: 600; color: var(--signal); }
  .top .spacer { flex: 1; }
  .theme-btn { background: var(--raised); border: 1px solid var(--line); border-radius: 999px; padding: 0.3rem 0.8rem; font-size: 0.82rem; }
  .theme-btn:hover { border-color: var(--line-strong); }

  /* ---- page head for member / party / archive pages ---- */
  .page-head-band { border-top: 1px solid var(--line); }
  .page-head { padding-top: 2.2rem; padding-bottom: 1.5rem; }
  .page-head h1 { font-size: clamp(1.8rem, 4vw, 2.6rem); line-height: 1.1; font-weight: 600; font-stretch: 80%; letter-spacing: -0.02em; display: flex; align-items: baseline; flex-wrap: wrap; gap: 0.2rem 0.75rem; }
  .page-head p { margin-top: 0.5rem; color: var(--sub); }
  .stats-bar { display: flex; flex-wrap: wrap; gap: 0.25rem 1.5rem; margin-top: 0.75rem; color: var(--sub); }
  .stats-bar strong { color: var(--ink); font-weight: 600; }

  /* ---- party marker: a coloured dot and the letter ---- */
  .party-tag { display: inline-flex; align-items: center; gap: 0.3rem; font-size: 0.78rem; font-weight: 500; color: var(--sub); white-space: nowrap; cursor: help; }
  .party-tag::before { content: ""; width: 0.5rem; height: 0.5rem; border-radius: 50%; background: var(--muted); }
  .party-tag.party-r::before { background: var(--rep); }
  .party-tag.party-d::before { background: var(--dem); }
  .page-head .party-tag { font-size: 1rem; font-stretch: 100%; }

  /* ---- sections and trade tables ---- */
  .section { padding-top: 1.5rem; padding-bottom: 1rem; }
  .section-header { display: flex; align-items: baseline; flex-wrap: wrap; gap: 0.25rem 0.75rem; margin-bottom: 0.5rem; }
  .section-title { font-size: 1.3rem; font-weight: 600; font-stretch: 85%; }
  .section-count { color: var(--muted); font-size: 0.9rem; }
  .csv-btn { margin-left: auto; background: none; border: 1px solid var(--line-strong); border-radius: 999px; padding: 0.25rem 0.85rem; font-size: 0.84rem; white-space: nowrap; }
  .csv-btn:hover { border-color: var(--ink); }
  .sales-table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  th { text-align: left; font-weight: 500; font-size: 0.82rem; color: var(--muted); padding: 0.6rem 0.6rem; border-bottom: 1px solid var(--line-strong); white-space: nowrap; }
  td { padding: 0.55rem 0.6rem; border-bottom: 1px solid var(--line); vertical-align: top; }
  tbody tr:hover td { background: var(--surface); }
  /* Newly disclosed since the previous run: marked, not reordered, because
     filings lag trades by weeks and would otherwise sit mid-table unnoticed. */
  tr.row-new td { background: var(--wash); }
  tr.row-new td:first-child { box-shadow: inset 3px 0 0 var(--signal); }
  .new-tag { display: inline-block; font-size: 0.72rem; font-weight: 600; color: var(--ground); background: var(--signal); border-radius: 3px; padding: 0 0.3rem; margin-left: 0.35rem; vertical-align: 1px; }
  .sale-date { white-space: nowrap; color: var(--sub); width: 8rem; }
  .sale-sym { font-weight: 700; white-space: nowrap; width: 5rem; }
  .sale-amount { white-space: nowrap; }
  .sale-trader { min-width: 11rem; }
  .trader-cell { display: flex; align-items: center; flex-wrap: wrap; gap: 0.2rem 0.45rem; }
  .sale-desc { color: var(--sub); }
  .symbol-link { text-decoration: none; }
  .symbol-link:hover { text-decoration: underline; text-decoration-color: var(--signal); }
  .no-ticker { font-size: 0.75rem; font-weight: 400; color: var(--muted); border: 1px solid var(--line-strong); border-radius: 4px; padding: 0 0.3rem; white-space: nowrap; }
  .filing-link { font-size: 0.82rem; color: var(--muted); white-space: nowrap; }
  .filing-link:hover { color: var(--ink); }
  /* Signals read as short words, not capitalised codes; the title still explains each. */
  .badge, .option-tag, .owner-tag {
    font-size: 0.75rem; color: var(--sub); border: 1px solid var(--line); border-radius: 4px;
    padding: 0 0.3rem; white-space: nowrap; cursor: help;
  }
  .badge-committee { color: var(--ink); border-color: var(--line-strong); }
  abbr.committee-abbr { text-decoration: underline dotted; text-underline-offset: 3px; cursor: help; }

  footer { max-width: var(--measure); margin: 2rem auto 0; padding: 1.5rem 1.5rem 5rem; border-top: 1px solid var(--line); font-size: 0.85rem; color: var(--muted); }

  /* ---- palette control (from equity-watch) ---- */
  .pal { position: fixed; left: 1.25rem; bottom: 1.1rem; z-index: 30; }
  .pal-toggle { display: flex; padding: 4px; border-radius: 999px; background: var(--raised); border: 1px solid var(--line); }
  .pal-toggle span, .pal-preset span { width: 14px; height: 14px; border-radius: 50%; box-shadow: 0 0 0 1px var(--line-strong); }
  .pal-toggle span + span, .pal-preset span + span { margin-left: -4px; }
  .pal-panel {
    position: absolute; left: 0; bottom: calc(100% + 8px); width: 15rem; padding: 0.9rem; display: grid; gap: 0.55rem;
    background: var(--raised); border: 1px solid var(--line); border-radius: 10px; box-shadow: var(--shadow); font-size: 0.82rem;
  }
  .pal-panel[hidden] { display: none; }
  .pal-panel button { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; }
  .pal-heading { font-weight: 600; font-size: 0.95rem; }
  .pal-presets { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
  .pal-preset { display: flex; justify-content: center; padding: 6px 4px; }
  .pal-field { display: flex; align-items: center; gap: 0.6rem; }
  .pal-field input { width: 2.2rem; height: 1.6rem; padding: 0; border: 1px solid var(--line); border-radius: 4px; background: none; }
  .pal-code { font-size: 0.75rem; color: var(--sub); user-select: all; }
  .pal-reset { font-size: 0.75rem; padding: 0.3rem; }

  @media (max-width: 640px) {
    .wrap { padding-left: 1rem; padding-right: 1rem; }
    .run, .crumbs { order: 3; flex-basis: 100%; }
    .run-latest { order: 3; }
    .pal { left: 1rem; }
  }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
`;

function escAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The masthead: brand (links to the archive), a middle slot, and the light/dark switch. */
export function siteHeader(homeHref: string, middle = ""): string {
  return `<header class="wrap top">
  <a class="brand site-brand" href="${escAttr(homeHref)}">Outlier Caucus</a>
  ${middle}
  <span class="spacer"></span>
  <button class="theme-btn" id="theme-btn" type="button">Light mode</button>
</header>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Text helpers shared by the page builders
// ─────────────────────────────────────────────────────────────────────────────

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-08-12" → "Aug 12", with the year when it differs from `thisYear` (pass "any" to always show it). */
export function shortDate(iso: string | null | undefined, thisYear?: string): string {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const [, y, mo, d] = m;
  return `${MONTHS[+mo - 1]} ${+d}${thisYear && y !== thisYear ? `, ${y}` : ""}`;
}

function shortMoney(n: number): string {
  if (n >= 1e6) return `$${+(n / 1e6).toFixed(1)}M`;
  if (n >= 1000) return `$${Math.round(n / 1000)}K`;
  return `$${n}`;
}

/** "$100,001 - $250,000" → "$100K–$250K"; exact amounts and odd strings pass through. */
export function shortAmount(amount: string | null | undefined): string {
  if (!amount) return "";
  const nums = (amount.match(/\d[\d,]*(\.\d+)?/g) ?? []).map((x) => +x.replace(/,/g, ""));
  if (nums.length === 2) return `${shortMoney(nums[0] - (nums[0] % 1000 === 1 ? 1 : 0))}–${shortMoney(nums[1])}`;
  if (nums.length === 1) {
    const open = /[-–]\s*$/.test(amount.trim()) || /over|more than/i.test(amount);
    if (nums[0] < 1000 || !open) return nums[0] < 1000 ? `$${nums[0]}` : shortMoney(nums[0]);
    return `${shortMoney(nums[0] - (nums[0] % 1000 === 1 ? 1 : 0))}+`;
  }
  return amount;
}

// Paper filings arrive in capitals; set them in normal case, keeping real acronyms.
const KEEP_UPPER = /^(&|S&P|BDC|LLC|LP|ETF|REIT|CMN|US|USA|LOC|MN|REV|ADR|NV|PLC|[IVXL]+,?|[A-Z]|.*\d.*)$/;
const LOWER_WORDS = /^(TO|OF|AND|THE|FOR|IN|ON|DUE|AT)$/;
const PROPER: Record<string, string> = { JPMORGAN: "JPMorgan" };

/** Asset description for display: normal case, and without a trailing "(TICKER)". */
export function tidyAsset(desc: string | null | undefined): string {
  let s = (desc ?? "").trim().replace(/\s*\([A-Z.]{1,6}\)\s*$/, "");
  if (s && s === s.toUpperCase() && /[A-Z]{4}/.test(s)) {
    s = s.split(/\s+/).map((w, i) =>
      PROPER[w] ?? (KEEP_UPPER.test(w) ? w : i > 0 && LOWER_WORDS.test(w) ? w.toLowerCase() : w.charAt(0) + w.slice(1).toLowerCase())
    ).join(" ");
  }
  return s;
}
