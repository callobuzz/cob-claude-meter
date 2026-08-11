import { Interval, mergeIntervals, sumDuration, toLocalDayKey } from './time-tracker.js';

/**
 * Wall-clock for arbitrary subsets of projects.
 *
 * Wall-clock is a union, not a sum: two terminals running the same hour is one
 * hour of wall-clock, not two. That means it cannot be reconstructed from
 * per-project totals once a filter is applied — it needs the underlying
 * intervals.
 *
 * Those intervals used to be shipped to the browser inside every report so the
 * client could fold them itself. That made the response grow with the whole
 * history: a year of sessions is megabytes of timestamps re-sent on every load
 * and every filter change, and it forced a second copy of the interval maths
 * into the browser that had to stay byte-compatible with this one forever.
 *
 * Keeping the fold here means the response carries numbers instead of raw
 * history, and the maths exists once.
 */

export type GroupBy = 'day' | 'week' | 'month';

export interface WallClockRequest {
  /** Project ids to include. An empty list means "none", not "all". */
  projects: string[];
  groupBy: GroupBy;
}

export interface WallClockResult {
  /** Union across the selected projects, clipped to the range. */
  totalMs: number;
  /** Union per time bucket, keyed the same way the timeline groups rows. */
  buckets: Record<string, number>;
}

/** Monday-anchored week key, matching how the timeline labels a week. */
export function weekKeyOf(dayKey: string): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const shift = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - shift);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${mm}-${dd}`;
}

export function monthKeyOf(dayKey: string): string {
  return dayKey.slice(0, 7);
}

export function bucketKeyOf(dayKey: string, groupBy: GroupBy): string {
  if (groupBy === 'week') return weekKeyOf(dayKey);
  if (groupBy === 'month') return monthKeyOf(dayKey);
  return dayKey;
}

/**
 * Local-time [start, end) bounds of a bucket key.
 *
 * Local, never UTC: a bucket boundary drawn in UTC would move evening work onto
 * the wrong day for anyone east or west of it.
 */
export function bucketBounds(key: string, groupBy: GroupBy): Interval {
  if (groupBy === 'month') {
    const [y, m] = key.split('-').map(Number);
    return [new Date(y, m - 1, 1).getTime(), new Date(y, m, 1).getTime()];
  }
  const [y, m, d] = key.split('-').map(Number);
  const span = groupBy === 'week' ? 7 : 1;
  return [new Date(y, m - 1, d).getTime(), new Date(y, m - 1, d + span).getTime()];
}

/** Overlap between a set of intervals and the window [start, end). */
export function durationWithin(intervals: Interval[], start: number, end: number): number {
  let total = 0;
  for (const [a, b] of intervals) {
    const lo = a > start ? a : start;
    const hi = b < end ? b : end;
    if (hi > lo) total += hi - lo;
  }
  return total;
}

/**
 * Folds the given projects' intervals into a union and measures it, whole and
 * per bucket.
 *
 * Buckets are derived from the union itself rather than from a caller-supplied
 * key list, so a range no project touches simply yields no bucket.
 */
export function computeWallClock(
  projectIntervals: Map<string, Interval[]>,
  request: WallClockRequest,
): WallClockResult {
  const all: Interval[] = [];
  for (const id of request.projects) {
    const intervals = projectIntervals.get(id);
    if (intervals) all.push(...intervals);
  }

  const union = mergeIntervals(all);
  const buckets: Record<string, number> = {};

  // Walk each union interval day by day so an overnight stretch lands in both
  // days, then roll the days up into whatever bucket size was asked for.
  for (const [start, end] of union) {
    let cursor = start;
    while (cursor < end) {
      const d = new Date(cursor);
      const nextMidnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
      const stop = Math.min(end, nextMidnight);
      const key = bucketKeyOf(toLocalDayKey(cursor), request.groupBy);
      buckets[key] = (buckets[key] ?? 0) + (stop - cursor);
      cursor = stop;
    }
  }

  return { totalMs: sumDuration(union), buckets };
}
