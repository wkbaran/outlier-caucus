import { test, expect } from "@playwright/test";
import { createNewlyDisclosedPredicate } from "../src/utils/filing-date.js";
import { carryFirstSeen } from "../src/services/trade-service.js";
import { previousRanAt } from "../src/output/index-page.js";

// The House posted Rogers' paper filing, received 9/23, on 9/28: after a report
// whose newest filing was dated 9/24. Its filing date says old; it was news.
const late = { lastName: "Rogers", dateRecieved: "9/23/2026", firstSeen: "2026-09-28T18:03:58Z" };

test("a trade first found after the previous report is new, whatever its filing date", () => {
  const isNew = createNewlyDisclosedPredicate("2026-09-24", { foundAfter: "2026-09-25T13:00:00Z" });
  expect(isNew(late)).toBe(true);
  expect(isNew({ ...late, firstSeen: "2026-09-25T12:00:00Z" })).toBe(false);
});

test("rebuilding an earlier report leaves out trades found after it ran", () => {
  const isNew = createNewlyDisclosedPredicate("2026-09-22", { foundAfter: "2026-09-25T13:00:00Z", foundThrough: "2026-09-27T00:00:00Z" });
  expect(isNew(late)).toBe(false);
});

test("trades stored before firstSeen fall back to the filing date", () => {
  const isNew = createNewlyDisclosedPredicate("2026-09-22", { foundAfter: null });
  expect(isNew({ dateRecieved: "9/23/2026" })).toBe(true);
  expect(isNew({ dateRecieved: "9/22/2026" })).toBe(false);
  expect(isNew(late)).toBe(true);
});

test("nothing is new without a previous report", () => {
  expect(createNewlyDisclosedPredicate(null)(late)).toBe(false);
});

test("a refresh keeps the first-seen time of trades it already had", () => {
  const before = [{ lastName: "A", symbol: "X", firstSeen: "2026-09-01T00:00:00Z" }, { lastName: "B", symbol: "Y" }];
  const fetched = [{ lastName: "A", symbol: "X" }, { lastName: "B", symbol: "Y" }, { lastName: "C", symbol: "Z" }];
  expect(carryFirstSeen(before, fetched, "2026-10-01T00:00:00Z").map((t) => t.firstSeen))
    .toEqual(["2026-09-01T00:00:00Z", undefined, "2026-10-01T00:00:00Z"]);
});

test("the previous run time comes from the latest earlier report that recorded one", () => {
  const manifest = [
    { date: "2026-09-30", ranAt: "2026-09-30T13:00:00Z" },
    { date: "2026-09-29", ranAt: "2026-09-29T00:12:00Z" },
    { date: "2026-09-25" },
  ] as never;
  expect(previousRanAt(manifest, "2026-09-30")).toBe("2026-09-29T00:12:00Z");
  expect(previousRanAt(manifest, "2026-09-29")).toBeNull();
});
