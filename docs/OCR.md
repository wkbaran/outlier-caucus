# Scanned filings (OCR)

Some members file on paper. The House publishes those as image-only PDFs, and the Senate as "paper filings" made of scanned GIF pages. Neither has text to parse, so each fetch records them in `data/unparseable-filings.json`, and an OCR step reads them with a local [Ollama](https://ollama.com) vision model. The default model, `qwen3.6:27b`, read the test pages with every field correct.

OCR is optional. Without a reachable Ollama the daily run logs a warning and carries on, and those filings just stay out of the report.

## How a filing is read

1. Each page is rendered to PNG with MuPDF. Pages scanned sideways (portrait for the landscape House form, or the reverse for the Senate form) are rotated first, because the model reads a sideways page into confident but wrong rows.
2. The model returns rows as JSON. A row becomes a trade only if its transaction date, amount range and purchase/sale type all normalize to known values. Account header rows, form boilerplate and implausible dates are dropped.
3. Every valid row is kept. A page where fewer than 80% of rows are valid is flagged for review in the log, but its readable rows still go in: a slightly wrong row is easier to notice in the report than a missing trade.
4. The ticker comes from the asset name when the filing writes one there ("Marsh Common Stock (MRSH)"), and from the model's ticker field only otherwise. The model sometimes fills that field with the House asset-type code (`ST` from `[ST]`) or a broker statement's share-class column (`CMN`), so those are dropped.
5. The ticker is then checked against the SEC's lists of listed companies (with their names) and of fund and ETF symbols, and against the company name on the filing. See [Ticker checks](#ticker-checks).
6. Rows are stored with `source: "ocr"` and shown with a **Scanned** tag in the report. A cleanly read filing replaces any rows stored for it. A filing with pages needing review only adds rows when nothing is stored for it yet.

Structured output is deliberately not used: constraining the model with Ollama's JSON-schema `format` made it misread the amount column on 10 of 25 rows of a test page.

## Ticker checks

A misread ticker is worse than a missing one: the trade gets the wrong company's size and sector, and counts toward the wrong stock's rarity. So each OCR'd row's ticker is checked against [`company_tickers.json`](https://www.sec.gov/files/company_tickers.json) and [`company_tickers_mf.json`](https://www.sec.gov/files/company_tickers_mf.json) from the SEC, cached in `data/sec-symbols.json` and refreshed weekly (needs `SEC_USER_AGENT`). Names are compared on their significant words, ignoring legal forms and security descriptions such as "Inc", "Common Stock" or "Sponsored ADR". The outcome is stored on the trade as `tickerCheck`, with the ticker as read in `ocrTicker`:

| `tickerCheck` | Meaning | Ticker kept |
|---|---|---|
| `verified` | A listed company whose name matches the filing | Yes |
| `fund` | A fund or ETF symbol. The SEC lists these without names, so only the symbol is checked | Yes |
| `corrected` | Unknown, or a company whose name doesn't match, while the filing's name matches exactly one listed company: `WMTD` became `WMT`, `VUZX` became `VUZI` | Replaced |
| `found-by-name` | No ticker was read, and the name matches exactly one listed company, such as the "TYLER TECHNOLOGIES, INC." rows on broker statements | Added |
| `manual` | Set by hand in `data/ticker-overrides.json` | As set |
| `name-mismatch` | A listed company with a different name, kept because the filing writes the ticker in the asset name | Yes |
| `rejected` | A listed company with a different name that the filing never writes, such as `GS` (Goldman Sachs) read off a municipal bond | Dropped |
| `unknown-symbol` | Neither listed nor found by name. Often an OTC or foreign listing | Yes |

Bonds, private funds and LLCs match nothing and keep no ticker. A name has to match exactly one company to be used, so an ambiguous name never picks one.

Names are matched leniently but never guessed: the same words in any order ("SCHWAB CHARLES CORP"), initials joined ("U.S. BANCORP"), statement abbreviations expanded ("INTL", "HLDG", "COS"), and a name cut off at a statement's column width ("UNITEDHEALTH GROUP INCORPORATE") matched to the one company it starts. Bonds, notes and options ("4.329% 09/21/2028", "HYBRID", "LINKED TO") never take their issuer's stock ticker, and funds only match their exact name.

A filing's tickers are checked once, when it's read. After that they stay as they are, so a scheduled run never changes a confirmed ticker. To re-check the stored trades, after adding an override or changing the matching rules, run `ocr:check-tickers`: a dry run that lists what would change, then `--write` to save. Checks start from `ocrTicker`, so re-running always gives the same answer.

### Fixing a ticker by hand

What the check can't settle (a misspelled name, a company the SEC no longer lists, a stock whose name matches several companies) is listed under "Data to check" at the foot of the report, in `attention` in `latest.json`, and at the end of the run log, with the fix. To set it, add the asset name exactly as the report shows it to `data/ticker-overrides.json`, with `""` for an asset that has no listed ticker:

```json
{
  "APLOVIN CORPORATION CMN CLASS A": "APP",
  "MARSH ORD CMN": "MRSH",
  "MH Built to Last LLC": ""
}
```

Names compare ignoring case and spacing. An override beats every other check and is marked `manual`. Filings read later pick it up when they're read; for trades already stored, run `ocr:check-tickers --write`. The next published report includes the change, or rebuild the current one with `report:html --no-fetch-trades --date <date> --publish`. In the Docker deployment the file lives in the state directory's `data/`, and commands run with `docker exec outlier-caucus node dist/index.js …`.

## Accuracy

House and Senate scans are both read by default (`OCR_CHAMBERS=house,senate`), but they aren't equally reliable. Hand-checked House pages came out with every field correct (71 of 71 rows). A Senate paper page had 3 of 10 rows wrong, with the amount column and purchase/sale misread. When a Senate paper filer's numbers look off, check the linked filing.

## Settings

| Variable | Default | |
|---|---|---|
| `OLLAMA_URL` | `http://localhost:11434` | The Ollama server |
| `OLLAMA_API_KEY` | unset | Sent as a bearer token, for an Ollama behind an authenticating proxy |
| `OCR_MODEL` | `qwen3.6:27b` | Vision model to use |
| `OCR_CHAMBERS` | `house,senate` | Which chambers' scans to read |
| `OCR_DAILY_MAX_PAGES` | `60` | Page budget for each daily run |
| `OCR_TIMEOUT_MS` | `600000` | Per-page timeout |

## Daily run

`report:html` runs OCR after fetching, for scanned filings not yet attempted, up to `OCR_DAILY_MAX_PAGES` pages. Larger filings wait for the catch-up command. Pass `--no-ocr` to skip it.

## Catch-up and review

A page takes about 100 seconds, so a backlog is worked through with `ocr:catchup` (or `ocr-catchup.ps1`, which wraps it and logs to a file):

```powershell
.\ocr-catchup.ps1 --list                 # what would be processed
.\ocr-catchup.ps1                        # everything not yet read
.\ocr-catchup.ps1 --limit 5              # a few filings at a time
.\ocr-catchup.ps1 --filing 9115726       # one filing
.\ocr-catchup.ps1 --retry                # re-run filings that failed or have pages needing review
```

Each run writes `logs\ocr-catchup-<timestamp>.log`: one line per page (status, rotation, valid and rejected rows, time), every rejected row and why, and a closing list of pages to review. For every page, `logs\ocr\<chamber>-<id>\page-N.json` holds the raw model output and validation, and pages needing review also get `page-N.png`. Per-filing outcomes are kept in `data/ocr-results.json`.

After a catch-up, regenerate and publish to include the new rows:

```bash
node dist/index.js report:html --no-fetch-trades --publish
```
