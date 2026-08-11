import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildIntervals,
  clipToRange,
  sumDuration,
  mergeIntervals,
  splitAtLocalMidnight,
  toLocalDayKey,
  resolveProjectRoot,
  scanSessionTimestamps,
  loadSessionTimeline,
  Interval,
} from '../../src/core/time-tracker.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(here, '..', 'fixtures', 'timeline.jsonl');

const MIN = 60_000;
const at = (minutes: number) => new Date(2026, 6, 15, 9, 0, 0).getTime() + minutes * MIN;

describe('buildIntervals', () => {
  it('joins entries closer together than the idle threshold', () => {
    const ts = [at(0), at(1), at(2)];
    expect(buildIntervals(ts, 300)).toEqual([[at(0), at(2)]]);
  });

  it('drops gaps longer than the idle threshold', () => {
    const ts = [at(0), at(1), at(60), at(61)];
    const intervals = buildIntervals(ts, 300);
    expect(intervals).toEqual([
      [at(0), at(1)],
      [at(60), at(61)],
    ]);
  });

  it('counts a long tool call as work when under the threshold', () => {
    const ts = [at(0), at(4)]; // 4 min gap, 5 min threshold
    expect(sumDuration(buildIntervals(ts, 300))).toBe(4 * MIN);
  });

  it('excludes an idle terminal entirely', () => {
    const ts = [at(0), at(120)]; // 2 hours of nothing
    expect(buildIntervals(ts, 300)).toEqual([]);
  });

  it('honours a custom threshold', () => {
    const ts = [at(0), at(3)];
    expect(buildIntervals(ts, 120)).toEqual([]);
    expect(buildIntervals(ts, 300)).toEqual([[at(0), at(3)]]);
  });

  it('returns nothing for a single timestamp', () => {
    expect(buildIntervals([at(0)], 300)).toEqual([]);
  });

  it('returns nothing for no timestamps', () => {
    expect(buildIntervals([], 300)).toEqual([]);
  });

  it('ignores zero-length gaps', () => {
    expect(buildIntervals([at(0), at(0)], 300)).toEqual([]);
  });
});

describe('sumDuration', () => {
  it('adds overlapping intervals separately', () => {
    // Two sessions, two hours each, fully overlapping -> 4h summed.
    const intervals: Interval[] = [
      [at(0), at(120)],
      [at(0), at(120)],
    ];
    expect(sumDuration(intervals)).toBe(240 * MIN);
  });
});

describe('mergeIntervals', () => {
  it('collapses fully overlapping intervals', () => {
    const intervals: Interval[] = [
      [at(0), at(120)],
      [at(0), at(120)],
    ];
    expect(sumDuration(mergeIntervals(intervals))).toBe(120 * MIN);
  });

  it('collapses partial overlap', () => {
    const intervals: Interval[] = [
      [at(0), at(60)],
      [at(30), at(90)],
    ];
    expect(mergeIntervals(intervals)).toEqual([[at(0), at(90)]]);
  });

  it('keeps disjoint intervals apart', () => {
    const intervals: Interval[] = [
      [at(0), at(30)],
      [at(60), at(90)],
    ];
    expect(mergeIntervals(intervals)).toHaveLength(2);
  });

  it('handles unsorted input', () => {
    const intervals: Interval[] = [
      [at(60), at(90)],
      [at(0), at(30)],
    ];
    expect(mergeIntervals(intervals)).toEqual([
      [at(0), at(30)],
      [at(60), at(90)],
    ]);
  });

  it('returns empty for empty input', () => {
    expect(mergeIntervals([])).toEqual([]);
  });
});

describe('clipToRange', () => {
  it('trims an interval straddling the range start', () => {
    expect(clipToRange([[at(0), at(60)]], at(30), at(90))).toEqual([[at(30), at(60)]]);
  });

  it('drops intervals fully outside the range', () => {
    expect(clipToRange([[at(0), at(10)]], at(30), at(90))).toEqual([]);
  });

  it('keeps intervals fully inside', () => {
    expect(clipToRange([[at(40), at(50)]], at(30), at(90))).toEqual([[at(40), at(50)]]);
  });
});

describe('splitAtLocalMidnight', () => {
  it('leaves a same-day interval intact', () => {
    const parts = splitAtLocalMidnight([at(0), at(60)]);
    expect(parts).toHaveLength(1);
    expect(parts[0].ms).toBe(60 * MIN);
  });

  it('splits an overnight interval across two days', () => {
    const start = new Date(2026, 6, 15, 23, 30).getTime();
    const end = new Date(2026, 6, 16, 0, 30).getTime();
    const parts = splitAtLocalMidnight([start, end]);

    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ day: '2026-07-15', ms: 30 * MIN });
    expect(parts[1]).toEqual({ day: '2026-07-16', ms: 30 * MIN });
  });

  it('conserves total duration when splitting', () => {
    const start = new Date(2026, 6, 15, 23, 0).getTime();
    const end = new Date(2026, 6, 16, 2, 0).getTime();
    const parts = splitAtLocalMidnight([start, end]);
    const total = parts.reduce((acc, p) => acc + p.ms, 0);
    expect(total).toBe(end - start);
  });
});

describe('toLocalDayKey', () => {
  it('uses local calendar date, not UTC', () => {
    const lateEvening = new Date(2026, 6, 15, 23, 59).getTime();
    expect(toLocalDayKey(lateEvening)).toBe('2026-07-15');
  });

  it('zero-pads month and day', () => {
    expect(toLocalDayKey(new Date(2026, 0, 5, 12, 0).getTime())).toBe('2026-01-05');
  });
});

describe('resolveProjectRoot', () => {
  it('returns null with no cwds', () => {
    expect(resolveProjectRoot(new Map())).toBeNull();
  });

  it('returns the only cwd', () => {
    const cwds = new Map([['C:\\work\\app', 10]]);
    expect(resolveProjectRoot(cwds)).toBe('C:\\work\\app');
  });

  it('picks the repo root over its subdirectories', () => {
    const cwds = new Map([
      ['C:\\work\\platform\\packages\\ui', 7722],
      ['C:\\work\\platform', 2144],
      ['C:\\work\\platform\\docs\\specs', 310],
    ]);
    expect(resolveProjectRoot(cwds)).toBe('C:\\work\\platform');
  });

  it('rejects a stale outlier path that nothing sits under', () => {
    // The real bug: `cob-cause-ops` appeared first in the file but only 35 times,
    // and no other entry lives beneath it.
    const cwds = new Map([
      ['C:\\work\\platform\\packages\\ui', 7722],
      ['C:\\work\\platform', 2144],
      ['C:\\work\\plat-form', 35],
    ]);
    expect(resolveProjectRoot(cwds)).toBe('C:\\work\\platform');
  });

  it('ignores a deep node_modules excursion', () => {
    const cwds = new Map([
      ['C:\\app', 100],
      ['C:\\app\\node_modules\\.pnpm\\stripe@22.3.2\\node_modules\\stripe', 33],
    ]);
    expect(resolveProjectRoot(cwds)).toBe('C:\\app');
  });

  it('handles posix paths', () => {
    const cwds = new Map([
      ['/home/dev/app/src', 50],
      ['/home/dev/app', 20],
    ]);
    expect(resolveProjectRoot(cwds)).toBe('/home/dev/app');
  });

  it('is case-insensitive on drive-letter paths', () => {
    const cwds = new Map([
      ['C:\\App\\src', 50],
      ['C:\\app', 20],
    ]);
    expect(resolveProjectRoot(cwds)).toBe('C:\\app');
  });

  it('strips a trailing separator', () => {
    const cwds = new Map([['C:\\app\\', 5]]);
    expect(resolveProjectRoot(cwds)).toBe('C:\\app');
  });
});

describe('scanSessionTimestamps', () => {
  it('keeps every timestamped entry, not just assistant usage', async () => {
    const { timestamps } = await scanSessionTimestamps(FIXTURE_PATH);
    // 6 timestamped lines: user, assistant, system, attachment, user, assistant
    expect(timestamps).toHaveLength(6);
  });

  it('returns timestamps in ascending order', async () => {
    const { timestamps } = await scanSessionTimestamps(FIXTURE_PATH);
    const sorted = [...timestamps].sort((a, b) => a - b);
    expect(timestamps).toEqual(sorted);
  });

  it('counts every cwd it sees', async () => {
    const { cwds } = await scanSessionTimestamps(FIXTURE_PATH);
    expect(cwds.get('C:\\work\\demo')).toBe(4);
    expect(cwds.get('C:\\work\\demo\\src')).toBe(1);
    expect(cwds.get('C:\\work\\stale-path')).toBe(1);
  });

  it('survives malformed lines', async () => {
    const { timestamps } = await scanSessionTimestamps(FIXTURE_PATH);
    expect(timestamps.length).toBeGreaterThan(0);
  });
});

describe('loadSessionTimeline', () => {
  it('derives sessionId from the filename', async () => {
    const { timeline } = await loadSessionTimeline(FIXTURE_PATH);
    expect(timeline.sessionId).toBe('timeline');
  });

  it('reports first and last activity', async () => {
    const { timeline } = await loadSessionTimeline(FIXTURE_PATH);
    expect(timeline.firstSeen).toBe(new Date('2026-07-15T09:00:00Z').getTime());
    expect(timeline.lastSeen).toBe(new Date('2026-07-15T11:30:00Z').getTime());
  });

  it('excludes the long idle stretch from active time', async () => {
    const { timeline } = await loadSessionTimeline(FIXTURE_PATH, 300);
    // 09:00->09:02->09:05->09:06 is continuous (6 min), then a 2h24m idle gap,
    // then 11:30 alone. Only the first block counts.
    expect(timeline.activeMs).toBe(6 * MIN);
  });

  it('resolves the project root past the stale path', async () => {
    const { cwds } = await loadSessionTimeline(FIXTURE_PATH);
    expect(resolveProjectRoot(cwds)).toBe('C:\\work\\demo');
  });
});
