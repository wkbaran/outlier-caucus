import { test, expect } from "@playwright/test";
import { buildMemberPage } from "../src/output/html.js";
import type { FMPTrade } from "../src/types/index.js";

// Exercises the real generator: on a long member page Sales starts many
// screens down, so the counts under the heading stick to the top as links.

function trade(i: number, type: string): { trade: FMPTrade; party: string } {
  return {
    party: "Republican",
    trade: {
      firstName: "Jane", lastName: "Smith", symbol: "MSFT", assetDescription: "Microsoft Corp",
      transactionDate: `2026-08-${String(28 - (i % 27)).padStart(2, "0")}`, type, amount: "$1,001 - $15,000",
      disclosureDate: `2026-09-${String(28 - (i % 27)).padStart(2, "0")}`,
    },
  };
}

const page = (purchases: number, sales: number) => buildMemberPage({
  memberName: "Jane Smith", chamber: "Rep.", party: "Republican", dateLabel: "October 19, 2026", reportUrl: "report.html",
  trades: [
    ...Array.from({ length: purchases }, (_, i) => trade(i, "Purchase")),
    ...Array.from({ length: sales }, (_, i) => trade(i, "Sale (Full)")),
  ],
  isNewlyDisclosed: (t) => (t.disclosureDate ?? "") >= "2026-09-28",
});

test("the sales count jumps to Sales and marks it, and Back to top returns", async ({ page: p }) => {
  await p.setContent(page(120, 40));
  await p.addStyleTag({ content: "html { scroll-behavior: auto !important; }" });
  const band = p.locator(".jump-band");
  await expect(p.locator(".to-top")).toBeHidden();

  await band.getByRole("link", { name: "40 sales" }).click();
  await expect(band).toHaveClass(/stuck/);
  await expect(band.getByRole("link", { name: "40 sales" })).toHaveAttribute("aria-current", "true");
  await expect(p.locator("#sales h2")).toBeInViewport();

  await p.locator(".to-top").click();
  await expect.poll(() => p.evaluate(() => scrollY)).toBe(0);
  await expect(band).not.toHaveClass(/stuck/);
});

test("a side with no trades is counted but not linked", async ({ page: p }) => {
  await p.setContent(page(5, 0));
  await expect(p.locator(".jump")).toContainText("0 sales");
  await expect(p.locator('.jump a[href="#sales"]')).toHaveCount(0);
});

test("member page marks trades disclosed since the previous report", () => {
  const html = page(2, 0);
  expect(html.match(/<span class="new-tag"/g)).toHaveLength(1);
});
