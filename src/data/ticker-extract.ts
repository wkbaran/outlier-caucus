/**
 * Recover a ticker that a filer wrote into the asset description instead of the
 * ticker field, e.g. Senate eFD rows with ticker "--" and an asset name of
 * "Recruit Holdings Co Ltd Unsponsored ADR (RCRUY)" or "SDZNY- Sandoz Group AG ADR".
 *
 * Deliberately conservative: only two unambiguous shapes are accepted, and the
 * token must be all-caps and not a common corporate/security word.
 */

// All-caps words that start descriptions ("GO BOND - ...", "USD - ...") but aren't tickers
const LEADING_STOPWORDS = new Set([
  "INC", "LLC", "LP", "LTD", "PLC", "CORP", "CO", "NEW", "CL", "CLASS", "SER", "SERIES",
  "ETF", "ETN", "ADR", "ADS", "REIT", "BDC", "UIT", "FUND", "TRUST", "NOTE", "NOTES", "BOND",
  "USD", "EUR", "GBP", "JPY", "AG", "SA", "NV", "SE", "SPA", "AB", "ASA", "OYJ", "KK",
  "GO", "REF", "REV", "DUE", "MAT", "CUSIP", "ISIN", "CRYPTO", "NA", "NYSE", "OTC",
]);
// A trailing "(XXX)" is almost always a ticker, so only reject security-type words here;
// real tickers like ETN (Eaton), SE (Sea Ltd), L and C must pass.
const TRAILING_STOPWORDS = new Set([
  "INC", "LLC", "LP", "LTD", "PLC", "CORP", "ETF", "ADR", "ADS", "REIT", "BDC", "UIT",
  "USD", "EUR", "GBP", "JPY", "CUSIP", "ISIN", "OTC",
  // Broker statements end names with these: "TJX COMPANIES INC (NEW)", "WALT DISNEY COMPANY (THE)"
  "NEW", "THE", "US", "DEL",
]);

// Common states of incorporation that filers append in parentheses
const INCORPORATION_STATES = new Set(["DE", "NV", "MD"]);
const CORPORATE_FORM_RE = /\b(?:Incorporated|Inc|Corporation|Corp)\b/i;

// "... Name (TICK)" or "... Name (BRK.B)" at the very end, optionally followed by an
// option expiry date: "Sony Group Corporation American Depositary Shares (SONY) 12/26/2026"
const TRAILING_PAREN_RE = /\(([A-Z]{1,5}(?:[./-][A-Z])?)\)\s*(?:\d{1,2}\/\d{1,2}\/\d{4})?\s*$/;

// "TICK - Name" or "TICK- Name" at the very start (a space must follow the dash, so
// "ROLLS-ROYCE HOLDINGS" is not read as ticker ROLLS)
const LEADING_PREFIX_RE = /^([A-Z]{1,5}(?:\.[A-Z])?)\s*-\s+\S/;

// House filings end the asset name with its asset-type code: "Boston Scientific Corp (BSX) [ST]"
const ASSET_TYPE_CODE_RE = /\s*\[[A-Z]{2}\]\s*$/;

export function extractTickerFromDescription(description: string | undefined | null): string | undefined {
  const text = (description ?? "").trim().replace(ASSET_TYPE_CODE_RE, "");
  if (!text) return undefined;

  const trailing = text.match(TRAILING_PAREN_RE)?.[1];
  // "UnitedHealth Group Incorporated Common Stock (DE)" names the state of
  // incorporation, not Deere; only trust a state code when no corporate form is named.
  const incorporationState = INCORPORATION_STATES.has(trailing ?? "") && CORPORATE_FORM_RE.test(text);
  if (trailing && !TRAILING_STOPWORDS.has(trailing) && !incorporationState) return trailing;

  const leading = text.match(LEADING_PREFIX_RE)?.[1];
  if (leading && leading.length >= 2 && !LEADING_STOPWORDS.has(leading)) return leading;

  return undefined;
}
