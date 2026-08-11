import { mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DayArchive, ArchivedDay, ALGO_VERSION, dayIsUnfinished, startOfToday } from '../../src/core/day-archive.js';
import { toLocalDayKey } from '../../src/core/time-tracker.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'meter-archive-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const dayKeyDaysAgo = (n: number) => toLocalDayKey(startOfToday() - n * DAY);

function entry(over: Partial<ArchivedDay> = {}): ArchivedDay {
  const day = over.day ?? dayKeyDaysAgo(3);
  const base = new Date(`${day}T09:00:00`).getTime();
  return {
    day,
    project: 'C:\\work\\alpha',
    name: 'alpha',
    totalMs: 2 * HOUR,
    intervals: [[base, base + 2 * HOUR]],
    sessionCount: 1,
    idleSeconds: 300,
    algo: ALGO_VERSION,
    ...over,
  };
}

describe('DayArchive', () => {
  it('stores a finished day and reads it back after reopening', () => {
    const a = new DayArchive(dir);
    expect(a.put(entry())).toBe(true);
    expect(a.save().ok).toBe(true);

    const reopened = new DayArchive(dir);
    reopened.load();
    const got = reopened.get(dayKeyDaysAgo(3), 'C:\\work\\alpha');
    expect(got?.totalMs).toBe(2 * HOUR);
    expect(got?.intervals).toHaveLength(1);
  });

  it('refuses to archive today, which is still being written to', () => {
    const today = toLocalDayKey(startOfToday());
    const a = new DayArchive(dir);

    expect(a.put(entry({ day: today }))).toBe(false);
    expect(a.size).toBe(0);
  });

  it('refuses a future day too', () => {
    const tomorrow = toLocalDayKey(startOfToday() + DAY);
    expect(new DayArchive(dir).put(entry({ day: tomorrow }))).toBe(false);
  });

  it('does not rewrite an entry whose numbers have not moved', () => {
    const a = new DayArchive(dir);
    expect(a.put(entry())).toBe(true);
    expect(a.put(entry())).toBe(false);
  });

  it('supersedes an entry when the numbers change', () => {
    const a = new DayArchive(dir);
    a.put(entry());
    expect(a.put(entry({ totalMs: 3 * HOUR }))).toBe(true);
    expect(a.get(dayKeyDaysAgo(3), 'C:\\work\\alpha')?.totalMs).toBe(3 * HOUR);
  });

  it('keeps only the last record for a day+project after a reload', () => {
    const a = new DayArchive(dir);
    a.put(entry());
    a.save();
    a.put(entry({ totalMs: 5 * HOUR }));
    a.save();

    const reopened = new DayArchive(dir);
    reopened.load();
    expect(reopened.size).toBe(1);
    expect(reopened.get(dayKeyDaysAgo(3), 'C:\\work\\alpha')?.totalMs).toBe(5 * HOUR);
  });

  it('returns only the days inside a requested range', () => {
    const a = new DayArchive(dir);
    for (const n of [1, 5, 10]) a.put(entry({ day: dayKeyDaysAgo(n) }));

    const got = a.range(dayKeyDaysAgo(6), dayKeyDaysAgo(1)).map(e => e.day).sort();
    expect(got).toEqual([dayKeyDaysAgo(5), dayKeyDaysAgo(1)].sort());
  });

  it('separates projects that share a day', () => {
    const a = new DayArchive(dir);
    a.put(entry({ project: 'C:\\work\\alpha' }));
    a.put(entry({ project: 'C:\\work\\beta', totalMs: HOUR }));

    expect(a.size).toBe(2);
    expect(a.get(dayKeyDaysAgo(3), 'C:\\work\\beta')?.totalMs).toBe(HOUR);
  });

  it('survives a torn final line from an interrupted append', () => {
    const a = new DayArchive(dir);
    a.put(entry({ day: dayKeyDaysAgo(4) }));
    a.put(entry({ day: dayKeyDaysAgo(5) }));
    a.save();

    appendFileSync(join(dir, 'day-archive.ndjson'), '{"day":"2026-01-01","proj', 'utf-8');

    const reopened = new DayArchive(dir);
    reopened.load();
    expect(reopened.size).toBe(2);
  });

  it('starts empty rather than misreading a future format version', () => {
    writeFileSync(
      join(dir, 'day-archive.ndjson'),
      JSON.stringify({ v: 999 }) + '\n' + JSON.stringify(entry()) + '\n',
      'utf-8',
    );

    const a = new DayArchive(dir);
    a.load();
    expect(a.size).toBe(0);
  });

  it('reports a failed save instead of throwing', () => {
    writeFileSync(join(dir, 'blocker'), 'x', 'utf-8');
    const a = new DayArchive(join(dir, 'blocker', 'nested'));
    a.put(entry());

    const result = a.save();
    expect(result.ok).toBe(false);
  });

  it('leaves no temp file behind when a save fails', () => {
    writeFileSync(join(dir, 'blocker2'), 'x', 'utf-8');
    const a = new DayArchive(join(dir, 'blocker2', 'nested'));
    a.put(entry());
    a.save();

    expect(readdirSync(dir).filter(f => f.endsWith('.tmp'))).toHaveLength(0);
  });

  it('compacts instead of growing forever as days are recomputed', () => {
    const a = new DayArchive(dir);
    a.put(entry());
    a.save();

    // Same day recomputed repeatedly, as a rules change would do.
    for (let i = 1; i <= 12; i++) {
      a.put(entry({ totalMs: i * HOUR }));
      a.save();
    }

    const lines = readFileSync(join(dir, 'day-archive.ndjson'), 'utf-8')
      .split('\n').filter(Boolean).length;
    // One header plus a small number of records — not one per save.
    expect(lines).toBeLessThan(8);

    const reopened = new DayArchive(dir);
    reopened.load();
    expect(reopened.get(dayKeyDaysAgo(3), 'C:\\work\\alpha')?.totalMs).toBe(12 * HOUR);
  });

  it('lists the days it holds, so history depth is visible', () => {
    const a = new DayArchive(dir);
    for (const n of [9, 2, 5]) a.put(entry({ day: dayKeyDaysAgo(n) }));
    expect(a.days()).toEqual([dayKeyDaysAgo(9), dayKeyDaysAgo(5), dayKeyDaysAgo(2)]);
  });

  it('keeps the entry when the rules change, so history is never lost', () => {
    // The point of the archive: once the logs are deleted the day cannot be
    // recomputed, and a number computed under older rules beats no number.
    const a = new DayArchive(dir);
    a.put(entry({ algo: ALGO_VERSION - 1 }));

    const stored = a.get(dayKeyDaysAgo(3), 'C:\\work\\alpha');
    expect(stored).not.toBeNull();
    expect(stored?.algo).toBe(ALGO_VERSION - 1);
  });
});

describe('dayIsUnfinished', () => {
  it('is true for today and false for yesterday', () => {
    expect(dayIsUnfinished(toLocalDayKey(startOfToday()))).toBe(true);
    expect(dayIsUnfinished(dayKeyDaysAgo(1))).toBe(false);
  });
});
