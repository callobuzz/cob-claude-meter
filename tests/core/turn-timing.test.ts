import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildSessionIntervals,
  scanSessionTimestamps,
  sumDuration,
  SessionScan,
} from '../../src/core/time-tracker.js';
import { TimelineCache } from '../../src/core/timeline-cache.js';

const MIN = 60_000;
const base = new Date(2026, 6, 15, 9, 0, 0).getTime();
const at = (minutes: number) => base + minutes * MIN;
const iso = (minutes: number) => new Date(at(minutes)).toISOString();

function scan(partial: Partial<SessionScan>): SessionScan {
  return { timestamps: [], cwds: new Map(), turns: [], ...partial };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'meter-turns-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeSession(name: string, lines: unknown[]): string {
  const p = join(dir, name);
  writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n'), 'utf-8');
  return p;
}

describe('scanSessionTimestamps: turn records', () => {
  it('reconstructs a turn interval backwards from its end stamp', async () => {
    const p = writeSession('a.jsonl', [
      { type: 'user', timestamp: iso(0), cwd: 'C:\\demo' },
      { type: 'system', subtype: 'turn_duration', durationMs: 12 * MIN, timestamp: iso(12) },
    ]);

    const { turns } = await scanSessionTimestamps(p);
    expect(turns).toEqual([[at(0), at(12)]]);
  });

  it('ignores system entries that are not turn durations', async () => {
    const p = writeSession('b.jsonl', [
      { type: 'system', subtype: 'stop_hook_summary', durationMs: 5 * MIN, timestamp: iso(5) },
      { type: 'system', subtype: 'away_summary', timestamp: iso(6) },
    ]);

    const { turns } = await scanSessionTimestamps(p);
    expect(turns).toEqual([]);
  });

  it('ignores a malformed or non-positive duration', async () => {
    const p = writeSession('c.jsonl', [
      { type: 'system', subtype: 'turn_duration', durationMs: 0, timestamp: iso(1) },
      { type: 'system', subtype: 'turn_duration', durationMs: -5, timestamp: iso(2) },
      { type: 'system', subtype: 'turn_duration', durationMs: 'nope', timestamp: iso(3) },
    ]);

    const { turns } = await scanSessionTimestamps(p);
    expect(turns).toEqual([]);
  });
});

describe('buildSessionIntervals', () => {
  it('counts a long tool call in full, with no threshold involved', () => {
    // One turn that spent 40 minutes inside a single build.
    const result = buildSessionIntervals(scan({ turns: [[at(0), at(40)]] }), 300);

    expect(result.source).toBe('turns');
    expect(sumDuration(result.intervals)).toBe(40 * MIN);
  });

  it('does not count the stretch between turns as work', () => {
    // Turn ends at :05, next turn starts at :35 — half an hour of the human
    // reading and typing, which is not the agent working.
    const result = buildSessionIntervals(
      scan({
        turns: [
          [at(0), at(5)],
          [at(35), at(40)],
        ],
      }),
      300,
    );

    expect(sumDuration(result.intervals)).toBe(10 * MIN);
  });

  it('never counts the same minute twice when turns overlap', () => {
    const result = buildSessionIntervals(
      scan({
        turns: [
          [at(0), at(10)],
          [at(5), at(15)],
        ],
      }),
      300,
    );

    expect(result.intervals).toEqual([[at(0), at(15)]]);
    expect(sumDuration(result.intervals)).toBe(15 * MIN);
  });

  it('falls back to gap inference when a session has no turn records', () => {
    const result = buildSessionIntervals(scan({ timestamps: [at(0), at(2), at(120)] }), 300);

    expect(result.source).toBe('gaps');
    expect(sumDuration(result.intervals)).toBe(2 * MIN);
  });

  it('ignores the idle threshold entirely when turn records exist', () => {
    const withTurns = scan({ turns: [[at(0), at(45)]], timestamps: [at(0), at(45)] });

    // A 30s threshold would demolish a gap-inferred result; measured time stands.
    expect(sumDuration(buildSessionIntervals(withTurns, 30).intervals)).toBe(45 * MIN);
    expect(sumDuration(buildSessionIntervals(withTurns, 3600).intervals)).toBe(45 * MIN);
  });
});

describe('TimelineCache', () => {
  it('keeps turn-measured entries valid across an idle-threshold change', () => {
    const p = writeSession('d.jsonl', [{ type: 'user', timestamp: iso(0) }]);
    const cache = new TimelineCache(dir);

    cache.set(p, {
      idleSeconds: 300,
      source: 'turns',
      intervals: [[at(0), at(10)]],
      cwds: [],
      firstSeen: at(0),
      lastSeen: at(10),
    });

    expect(cache.get(p, 300)).not.toBeNull();
    expect(cache.get(p, 900)).not.toBeNull(); // threshold-independent
  });

  it('still invalidates gap-inferred entries when the threshold changes', () => {
    const p = writeSession('e.jsonl', [{ type: 'user', timestamp: iso(0) }]);
    const cache = new TimelineCache(dir);

    cache.set(p, {
      idleSeconds: 300,
      source: 'gaps',
      intervals: [[at(0), at(10)]],
      cwds: [],
      firstSeen: at(0),
      lastSeen: at(10),
    });

    expect(cache.get(p, 300)).not.toBeNull();
    expect(cache.get(p, 900)).toBeNull();
  });

  it('reports a failed save instead of throwing', () => {
    const p = writeSession('f.jsonl', [{ type: 'user', timestamp: iso(0) }]);
    // A path that cannot be written to: an existing *file* used as the cache dir.
    const blocked = join(dir, 'f.jsonl', 'nested');
    const cache = new TimelineCache(blocked);

    cache.set(p, {
      idleSeconds: 300,
      source: 'turns',
      intervals: [[at(0), at(10)]],
      cwds: [],
      firstSeen: at(0),
      lastSeen: at(10),
    });

    const result = cache.save();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(typeof result.reason).toBe('string');
  });

  it('leaves no temp file behind when a save fails', () => {
    const p = writeSession('g.jsonl', [{ type: 'user', timestamp: iso(0) }]);
    const blocked = join(dir, 'g.jsonl', 'nested');
    const cache = new TimelineCache(blocked);

    cache.set(p, {
      idleSeconds: 300,
      source: 'turns',
      intervals: [[at(0), at(10)]],
      cwds: [],
      firstSeen: at(0),
      lastSeen: at(10),
    });
    cache.save();

    expect(readdirSync(dir).filter(f => f.endsWith('.tmp'))).toHaveLength(0);
  });

  it('round-trips a saved cache through load()', () => {
    const p = writeSession('h.jsonl', [{ type: 'user', timestamp: iso(0) }]);
    const cache = new TimelineCache(dir);

    cache.set(p, {
      idleSeconds: 300,
      source: 'turns',
      intervals: [[at(0), at(10)]],
      cwds: [['C:\\demo', 3]],
      firstSeen: at(0),
      lastSeen: at(10),
    });
    expect(cache.save().ok).toBe(true);

    const reopened = new TimelineCache(dir);
    reopened.load();
    expect(reopened.get(p, 300)?.intervals).toEqual([[at(0), at(10)]]);
  });

  it('sweeps temp files an earlier crash left behind', () => {
    writeFileSync(join(dir, 'timeline-deadbeef.tmp'), '', 'utf-8');
    writeFileSync(join(dir, 'timeline-cache.json'), '{}', 'utf-8');

    const removed = new TimelineCache(dir).sweepTempFiles();

    expect(removed).toBe(1);
    expect(readdirSync(dir).filter(f => f.endsWith('.tmp'))).toHaveLength(0);
  });
});
