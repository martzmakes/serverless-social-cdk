import { expect, it } from "vitest";
import { sortTrendRows } from "../trends-web";
import type { TrendItem } from "../insights";

const items: TrendItem[] = [
  { rkey: "older", title: "Zebra", url: "", publishedAt: "2026-11-18T11:00:00Z", values: [21, 34] },
  { rkey: "newer", title: "Apple", url: "", publishedAt: "2026-11-18T09:00:00-05:00", values: [5, 1] },
  { rkey: "no-history", title: "Cedar", url: "", publishedAt: "", values: [null, null] },
];

it("sorts by view count, chronological publication date, and title in either direction", () => {
  for (const [column, ascending, descending] of [
    ["total", ["newer", "older", "no-history"], ["older", "newer", "no-history"]],
    ["publishedAt", ["older", "newer", "no-history"], ["newer", "older", "no-history"]],
    ["title", ["newer", "no-history", "older"], ["older", "no-history", "newer"]],
  ] as const) {
    expect(sortTrendRows(items, "article", { column, direction: "ascending" }).map(row => row.item.rkey)).toEqual(ascending);
    expect(sortTrendRows(items, "article", { column, direction: "descending" }).map(row => row.item.rkey)).toEqual(descending);
  }
});

it("uses the latest snapshot for short posts and daily totals for article views", () => {
  expect(sortTrendRows(items, "post", { column: "total", direction: "descending" }).map(row => row.total))
    .toEqual([34, 1, undefined]);
  expect(sortTrendRows(items, "article", { column: "total", direction: "descending" }).map(row => row.total))
    .toEqual([55, 6, undefined]);
});
