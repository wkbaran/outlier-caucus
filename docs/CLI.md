# CLI

Run commands with `node dist/index.js <command>` after `npm run build`, or `npm run dev -- <command>` to run from source. `npm link` installs an `outlier-caucus` command so you can drop the `node dist/index.js`. Every command takes `--help`.

Settings come from environment variables; `node --env-file=.env` loads them from a file. `.env.example` lists them all.

## Commands

| Command | Does |
|---|---|
| `report:html` | Fetches new filings, OCRs scanned ones, scores everything, and writes the website. [Publishing](PUBLISHING.md) covers its options |
| `analyze` | Fetches and scores, then prints the top trades in the terminal |
| `run` | Fetches committee and trade data, then analyzes: `analyze` plus a committee refresh |
| `fetch:trades` | Fetches new trades only |
| `fetch:committees` | Refreshes members, parties and committee membership |
| `ocr:catchup` | Works through the backlog of scanned filings. See [OCR](OCR.md) |
| `ocr:check-tickers` | Checks OCR'd trades' tickers against the SEC symbol lists; `--write` saves the corrections. See [OCR](OCR.md#ticker-checks) |
| `list:trades` | Recent trades, filterable by `--chamber`, `--trader`, `--symbol` or `--relevant-only` (committee overlap) |
| `list:committees` | Each committee with the sectors it oversees and its members |
| `report:sales` | Every sale, formatted for checking against your own holdings |
| `status` | What's cached and how old it is |
| `fetch:taxonomy` | FMP's sector and industry list compared with the committee map. Needs `FMP_API_KEY` |

### analyze

```bash
node dist/index.js analyze                     # purchases scoring 40 or more
node dist/index.js analyze --since 2026-09-01  # only trades from this date (still scores against the full history)
node dist/index.js analyze --new-only          # only trades not shown by a previous run
```

| Option | |
|---|---|
| `--min-score <n>` | Lowest score to show (default 40) |
| `--top <n>` | Show at most this many (default all) |
| `--type <type>` | `purchase` (default, includes exchanges), `sale` or `all` |
| `--since <date>` | Only show trades from this date on |
| `--new-only` | Skip trades shown before. Remembered in `data/seen-trades.json`; delete it to reset |
| `--no-fetch-trades` | Use the cached trades |
| `-r, --refresh` | Refetch everything instead of only what's new |
| `--no-market-data` | Skip company data. Faster, but no market cap or committee scores |
| `--market-data-ttl <days>` | How long company data is cached (default 30) |
| `--json` | Raw JSON output |

Formatted output is also saved to `formatted-reports/`.

## Fetching

Fetches are incremental: each run starts from the newest stored trade, minus a 30-day overlap so a filing that reaches the index late isn't missed. The House and Senate filing IDs already read are remembered, so the overlap costs little. `--refresh` refetches from `--since` (default one year ago).

Trades are deduplicated by member, transaction date, ticker, type, amount and owner.

## What's cached

Everything lives in `data/`.

| File | Holds | Refreshed |
|---|---|---|
| `trades.json` | Every trade | Incrementally, each fetch |
| `house-seen-docids.json`, `senate-seen-guids.json` | Filings already read | Each fetch |
| `unparseable-filings.json` | Scanned filings waiting for OCR | Each fetch |
| `ocr-results.json` | What OCR made of each scanned filing | Each OCR run |
| `market-data-cache.json` | Company size, sector and industry per ticker | After 30 days (`--market-data-ttl`) |
| `edgar-ticker-cik.json` | SEC ticker to company map | After 7 days |
| `sec-symbols.json` | SEC company tickers with names, and fund symbols, for checking OCR'd tickers | After 7 days |
| `committee-data.json` | Members, parties and committees | Weekly, by `report:html` |
| `seen-trades.json` | Trades shown by `analyze --new-only` | Each `--new-only` run |

The analysis behind each report is saved in `reports/`, which is what `report:html --render-only` reuses.

## Using FMP instead

Set `DATA_SOURCE=fmp` and `FMP_API_KEY` to take trades and company data from [Financial Modeling Prep](https://financialmodelingprep.com/) instead of the House, Senate and SEC. The default public sources need no key.
