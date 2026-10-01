import { test, expect } from "@playwright/test";
import { extractTickerFromDescription } from "../src/data/ticker-extract.js";

// Real asset descriptions from Senate eFD / House PTR rows whose ticker field was empty.

test("trailing parenthesized ticker is extracted", () => {
  const cases: Array<[string, string]> = [
    ["Recruit Holdings Co Ltd Unsponsored ADR (RCRUY)", "RCRUY"],
    ["Zurich Insurance Group Ltd Sponsored ADR (ZURVY)", "ZURVY"],
    ["Atlas Copco AB New Shares Representing Series A Common Stock (Sponsored) (ATLKY)", "ATLKY"],
    ["BHP Group Limited (BHP)", "BHP"],
    ["Bank of New York Mellon Corp (BK)", "BK"],
    ["Loews Corporation (L)", "L"],
    ["Citigroup New Inc (C)", "C"],
    ["Sea Limited (SE)", "SE"],
    ["Eaton Corporation, PLC Ordinary Shares (ETN)", "ETN"],
    ["Berkshire Hathaway Inc. New Common Stock (BRK.B)", "BRK.B"],
    ["Deere & Company Common Stock (DE)", "DE"],
    ["Sony Group Corporation American Depositary Shares (SONY) 12/26/2026", "SONY"],
  ];
  for (const [desc, ticker] of cases) expect(extractTickerFromDescription(desc), desc).toBe(ticker);
});

test("leading 'TICK - ' / 'TICK- ' prefix is extracted", () => {
  const cases: Array<[string, string]> = [
    ["SDZNY- Sandoz Group AG ADR", "SDZNY"],
    ["SPYM - Tradr 2X Long SPY Monthly ETF", "SPYM"],
    ["CEG - Constellation Energy Corporation - Common Stock When-Issued", "CEG"],
    ["GOOGL - Alphabet Inc. - Class C Capital Stock", "GOOGL"],
    ["ACN - Accenture plc Class A Ordinary Shares (Ireland)", "ACN"],
    ["DIA - State Street SPDR Dow Jones", "DIA"],
  ];
  for (const [desc, ticker] of cases) expect(extractTickerFromDescription(desc), desc).toBe(ticker);
});

test("descriptions without a clear ticker yield nothing", () => {
  const none = [
    "ROLLS-ROYCE HOLDINGS PLC SPONSORED ADR",
    "GS Managed Structured Note Strategy S&P 500 Linked Note",
    "Advanced Machine Intelligence (AMI) Labs",
    "Bitcoin (CRYPTO:BTC)",
    "Hensoldt AG (Sponsored)",
    "Ansett Aerospace Holdings LLC - Regaero Holdings Pty Ltd Company: Regaero Holdings Pty Ltd (Melbourne, Australia)",
    "Trimer Capital Partners I LP (GLAS",
    "Madison Conn GO BD 3.5% 12/18/25",
    "U.S. Treasury Note due 2/28/2029",
    "Berkshire Hathaway Inc. New",
    "UnitedHealth Group Incorporated Common Stock (DE)",
    "Some Fund (ETF)",
    "Widget Holdings (INC)",
    "",
  ];
  for (const desc of none) expect(extractTickerFromDescription(desc), desc).toBeUndefined();
});

test("a trailing House asset-type code does not hide the ticker", () => {
  expect(extractTickerFromDescription("Boston Scientific Corporation Common Stock (BSX) [ST]")).toBe("BSX");
  expect(extractTickerFromDescription("Eaton Corporation, PLC Ordinary Shares (ETN) [ST]")).toBe("ETN");
  expect(extractTickerFromDescription("TULSA OKLA MET UTIL AUTH REV BDS SER. A [GS]")).toBeUndefined();
});
