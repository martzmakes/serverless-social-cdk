import type { TrendKind } from "../../../insights";

const dayLength = 86_400_000;

export function trendDays(range: number, now = Date.now()) {
  const today = Math.floor(now / dayLength) * dayLength;
  return Array.from({ length: range }, (_, i) => new Date(today - (range - i - 1) * dayLength).toISOString().slice(0, 10));
}

const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/** Page views are daily counts. Network engagement rows are cumulative snapshots. */
export function trendValues(
  kind: TrendKind,
  days: string[],
  publishedAt: string,
  rows: Record<string, unknown>[],
): (number | null)[] {
  const published = publishedAt.slice(0, 10);
  const observed = new Map<string, number>();
  for (const row of rows) {
    if (typeof row.sk !== "string") continue;
    const value = kind === "article" ? count(row.views) : (() => {
      const metrics = [count(row.likes), count(row.reposts), count(row.replies)];
      return metrics.every(metric => metric !== undefined) ? metrics.reduce<number>((sum, metric) => sum + (metric ?? 0), 0) : undefined;
    })();
    if (value !== undefined) observed.set(row.sk, value);
  }
  return days.map(day => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(published) && day < published) return null;
    return observed.get(day) ?? null;
  });
}
