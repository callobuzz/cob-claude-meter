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
  return { timestamps: [], cwds: new Map(), turns: [], toolSpans: [], ...partial };
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

  it('never lets the threshold shrink measured time', () => {
    const withTurns = scan({ turns: [[at(0), at(45)]], timestamps: [at(0), at(45)] });

    // The threshold governs the stretches *between* measured spans. It can add
    // to a total by joining two of them, but a measured 45 minutes is 45
    // minutes however tight the cutoff is set.
    expect(sumDuration(buildSessionIntervals(withTurns, 30).intervals)).toBe(45 * MIN);
    expect(sumDuration(buildSessionIntervals(withTurns, 3600).intervals)).toBe(45 * MIN);
  });
});

describe('TimelineCache', () => {
  it('invalidates turn-measured entries when the threshold changes', () => {
    // The threshold decides whether the stretch between two measured turns is
    // one piece of work or two, so turn-measured totals depend on it as well.
    // Reusing these across a change served the previous setting's numbers.
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
    expect(cache.get(p, 900)).toBeNull();
  });

  it('also invalidates gap-inferred entries when the threshold changes', () => {
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

describe('scanSessionTimestamps: tool spans', () => {
  /**
   * A subagent writes its own transcript under `<session>/subagents/`, which
   * this tool never reads — those files are comparable in size to the sessions
   * themselves. The parent records the Agent call and the result that came
   * back, so the span is recoverable without reading them.
   */
  it('pairs a tool_use with the tool_result that echoes its id', async () => {
    const p = writeSession('spans.jsonl', [
      { type: 'assistant', timestamp: iso(0), message: { content: [{ type: 'tool_use', id: 't1', name: 'Agent' }] } },
      { type: 'user', timestamp: iso(20), message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } },
    ]);

    const { toolSpans } = await scanSessionTimestamps(p);
    expect(toolSpans).toEqual([[at(0), at(20)]]);
  });

  it('handles several tools open at once, finishing out of order', async () => {
    const p = writeSession('parallel.jsonl', [
      { type: 'assistant', timestamp: iso(0), message: { content: [
        { type: 'tool_use', id: 'a', name: 'Agent' },
        { type: 'tool_use', id: 'b', name: 'Bash' },
      ] } },
      { type: 'user', timestamp: iso(9), message: { content: [{ type: 'tool_result', tool_use_id: 'b' }] } },
      { type: 'user', timestamp: iso(30), message: { content: [{ type: 'tool_result', tool_use_id: 'a' }] } },
    ]);

    const { toolSpans } = await scanSessionTimestamps(p);
    expect(toolSpans).toEqual([[at(0), at(9)], [at(0), at(30)]]);
  });

  /**
   * The permission-prompt problem, and the evidence that fixes it.
   *
   * Claude Code's `durationMs` already includes the tools that ran inside the
   * turn — that is what makes a long build count. So a foreground tool cannot
   * honestly have been open longer than the turn ran: the difference is the
   * call sitting open while the turn was stopped, waiting for approval.
   */
  it('drops a foreground span that outran the turn it belongs to', async () => {
    const p = writeSession('waited.jsonl', [
      { type: 'assistant', timestamp: iso(0), message: { content: [{ type: 'tool_use', id: 'b', name: 'Bash' }] } },
      // Approved an hour later; the turn itself only ran two minutes.
      { type: 'user', timestamp: iso(60), message: { content: [{ type: 'tool_result', tool_use_id: 'b' }] } },
      { type: 'system', subtype: 'turn_duration', durationMs: 2 * MIN, timestamp: iso(60) },
    ]);

    const { toolSpans, turns } = await scanSessionTimestamps(p);
    expect(toolSpans).toEqual([]);
    expect(turns).toEqual([[at(58), at(60)]]);
  });

  it('keeps a foreground span that fits inside its turn', async () => {
    const p = writeSession('honest.jsonl', [
      { type: 'assistant', timestamp: iso(0), message: { content: [{ type: 'tool_use', id: 'b', name: 'Bash' }] } },
      { type: 'user', timestamp: iso(12), message: { content: [{ type: 'tool_result', tool_use_id: 'b' }] } },
      { type: 'system', subtype: 'turn_duration', durationMs: 30 * MIN, timestamp: iso(30) },
    ]);

    const { toolSpans } = await scanSessionTimestamps(p);
    expect(toolSpans).toEqual([[at(0), at(12)]]);
  });

  it('never caps a subagent, which really does outlive its turn', async () => {
    // The whole point of counting spans. An Agent runs unattended while Claude
    // Code has already stopped counting the turn.
    const p = writeSession('detached.jsonl', [
      { type: 'assistant', timestamp: iso(0), message: { content: [{ type: 'tool_use', id: 'a', name: 'Agent' }] } },
      { type: 'user', timestamp: iso(40), message: { content: [{ type: 'tool_result', tool_use_id: 'a' }] } },
      { type: 'system', subtype: 'turn_duration', durationMs: MIN, timestamp: iso(40) },
    ]);

    const { toolSpans } = await scanSessionTimestamps(p);
    expect(toolSpans).toEqual([[at(0), at(40)]]);
  });

  it('never caps a tool explicitly launched in the background', async () => {
    const p = writeSession('bg.jsonl', [
      { type: 'assistant', timestamp: iso(0), message: { content: [
        { type: 'tool_use', id: 'b', name: 'Bash', input: { run_in_background: true } },
      ] } },
      { type: 'user', timestamp: iso(45), message: { content: [{ type: 'tool_result', tool_use_id: 'b' }] } },
      { type: 'system', subtype: 'turn_duration', durationMs: MIN, timestamp: iso(45) },
    ]);

    const { toolSpans } = await scanSessionTimestamps(p);
    expect(toolSpans).toEqual([[at(0), at(45)]]);
  });

  it('judges each turn separately rather than the session as a whole', async () => {
    const p = writeSession('two-turns.jsonl', [
      // Turn one: honest.
      { type: 'assistant', timestamp: iso(0), message: { content: [{ type: 'tool_use', id: 'x', name: 'Bash' }] } },
      { type: 'user', timestamp: iso(5), message: { content: [{ type: 'tool_result', tool_use_id: 'x' }] } },
      { type: 'system', subtype: 'turn_duration', durationMs: 10 * MIN, timestamp: iso(10) },
      // Turn two: an approval left pending.
      { type: 'assistant', timestamp: iso(11), message: { content: [{ type: 'tool_use', id: 'y', name: 'Bash' }] } },
      { type: 'user', timestamp: iso(90), message: { content: [{ type: 'tool_result', tool_use_id: 'y' }] } },
      { type: 'system', subtype: 'turn_duration', durationMs: MIN, timestamp: iso(90) },
    ]);

    const { toolSpans } = await scanSessionTimestamps(p);
    expect(toolSpans).toEqual([[at(0), at(5)]]);
  });

  it('keeps a span whose turn never closed, having nothing to judge it against', async () => {
    // A session still in flight when the report runs.
    const p = writeSession('midflight.jsonl', [
      { type: 'assistant', timestamp: iso(0), message: { content: [{ type: 'tool_use', id: 'b', name: 'Bash' }] } },
      { type: 'user', timestamp: iso(7), message: { content: [{ type: 'tool_result', tool_use_id: 'b' }] } },
    ]);

    const { toolSpans } = await scanSessionTimestamps(p);
    expect(toolSpans).toEqual([[at(0), at(7)]]);
  });

  it('excludes tools that are the agent waiting on a person', async () => {
    // Left open over lunch this is hours long, and none of it is work.
    const p = writeSession('asking.jsonl', [
      { type: 'assistant', timestamp: iso(0), message: { content: [{ type: 'tool_use', id: 'q', name: 'AskUserQuestion' }] } },
      { type: 'user', timestamp: iso(240), message: { content: [{ type: 'tool_result', tool_use_id: 'q' }] } },
    ]);

    const { toolSpans } = await scanSessionTimestamps(p);
    expect(toolSpans).toEqual([]);
  });

  it('drops a tool that never returned rather than inventing an end', async () => {
    const p = writeSession('orphan.jsonl', [
      { type: 'assistant', timestamp: iso(0), message: { content: [{ type: 'tool_use', id: 'x', name: 'Bash' }] } },
    ]);

    const { toolSpans } = await scanSessionTimestamps(p);
    expect(toolSpans).toEqual([]);
  });

  it('ignores a result whose opener is missing', async () => {
    const p = writeSession('stray.jsonl', [
      { type: 'user', timestamp: iso(5), message: { content: [{ type: 'tool_result', tool_use_id: 'gone' }] } },
    ]);

    const { toolSpans } = await scanSessionTimestamps(p);
    expect(toolSpans).toEqual([]);
  });
});

describe('buildSessionIntervals: combining the evidence', () => {
  it('counts a subagent span that no turn record covers', async () => {
    const s = scan({
      timestamps: [at(0), at(40)],
      turns: [[at(0), at(5)]],
      toolSpans: [[at(6), at(40)]],
    });

    const { intervals, source } = buildSessionIntervals(s, 300);
    expect(source).toBe('turns');
    // 0-5 measured, 6-40 the subagent, and the one-minute gap between them
    // bridged because entries sit either side of it.
    expect(sumDuration(intervals)).toBe(40 * MIN);
  });

  it('does not double-count a span that sits inside its turn', async () => {
    const s = scan({
      timestamps: [at(0), at(30)],
      turns: [[at(0), at(30)]],
      toolSpans: [[at(2), at(28)]],
    });

    expect(sumDuration(buildSessionIntervals(s, 300).intervals)).toBe(30 * MIN);
  });

  it('splits at a silence longer than the threshold', async () => {
    const s = scan({
      timestamps: [at(0), at(10), at(90), at(100)],
      turns: [[at(0), at(10)], [at(90), at(100)]],
    });

    // 80 minutes of nothing between them: two pieces of work, not one.
    expect(sumDuration(buildSessionIntervals(s, 300).intervals)).toBe(20 * MIN);
  });

  it('joins two turns across a gap below the threshold', async () => {
    const s = scan({
      timestamps: [at(0), at(10), at(12), at(20)],
      turns: [[at(0), at(10)], [at(12), at(20)]],
    });

    expect(sumDuration(buildSessionIntervals(s, 300).intervals)).toBe(20 * MIN);
  });

  it('reports gaps as the source when only tool spans exist', async () => {
    const s = scan({ timestamps: [at(0), at(8)], toolSpans: [[at(0), at(8)]] });
    expect(buildSessionIntervals(s, 300).source).toBe('gaps');
  });
});
