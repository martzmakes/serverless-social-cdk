import { describe, expect, it } from "vitest";
import { trendDays, trendValues } from "../lib/lambdas/analytics/workspace-trends";

describe("workspace trend history", () => {
  const days = trendDays(7, Date.UTC(2026, 10, 20, 23, 45));

  it("uses UTC day boundaries and leaves pre-publication days and unobserved days blank", () => {
    expect(days).toEqual(["2026-11-14", "2026-11-15", "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20"]);
    expect(trendValues("article", days, "2026-11-18T01:00:00Z", [
      { sk: "2026-11-16", views: 9 },
      { sk: "2026-11-18", views: 0 },
      { sk: "2026-11-20", views: 5 },
    ])).toEqual([null, null, null, null, 0, null, 5]);
  });

  it("keeps each Bluesky row as a snapshot and avoids inventing engagement for incomplete rows", () => {
    expect(trendValues("post", days, "2026-11-18T00:00:00Z", [
      { sk: "2026-11-18", likes: 1, reposts: 2, replies: 0 },
      { sk: "2026-11-19", likes: 2, reposts: 2 },
      { sk: "2026-11-20", likes: 2, reposts: 2, replies: 1 },
    ])).toEqual([null, null, null, null, 3, null, 5]);
  });
});
