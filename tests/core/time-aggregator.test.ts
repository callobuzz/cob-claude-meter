import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildTimeReport } from '../../src/core/time-aggregator.js';
import { mergeIntervals, scanSessionTimestamps, sumDuration } from '../../src/core/time-tracker.js';

const MIN = 60_000;

/** Builds a session log whose entries sit `stepMin` apart, starting at `start`. */
function sessionLines(cwd: string, start: Date, count: number, stepMin: number): string {
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    const ts = new Date(start.getTime() + i * stepMin * MIN).toISOString();
    lines.push(JSON.stringify({
      type: i % 2 === 0 ? 'user' : 'assistant',
      cwd,
      timestamp: ts,
      sessionId: 'x',
    }));
  }
  return lines.join('\n') + '\n';
}

describe('buildTimeReport', () => {
  let root: string;
  let logs: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'claude-meter-agg-'));
    logs = join(root, 'projects');
    mkdirSync(logs, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function project(dirName: string) {
    const dir = join(logs, dirName);
    mkdirSync(dir, { recursive: true });
    return {
      dir,
      session(name: string, cwd: string, start: Date, count: number, stepMin = 1) {
        writeFileSync(join(dir, `${name}.jsonl`), sessionLines(cwd, start, count, stepMin), 'utf-8');
        return this;
      },
    };
  }

  it('sums two concurrent sessions of the same project', async () => {
    // Both run 09:00-10:00 on the same day: 1h + 1h = 2h summed, 1h wall-clock.
    const start = new Date(2026, 6, 15, 9, 0);
    project('P--app')
      .session('a', 'C:\\app', start, 61, 1)
      .session('b', 'C:\\app', start, 61, 1);

    const report = await buildTimeReport({ logPaths: [logs], idleSeconds: 300 });

    expect(report.projects).toHaveLength(1);
    expect(report.projects[0].totalMs).toBe(120 * MIN);
    expect(report.projects[0].wallClockMs).toBe(60 * MIN);
    expect(report.projects[0].sessionCount).toBe(2);
  });

  it('reports summed total above wall-clock across different projects', async () => {
    const start = new Date(2026, 6, 15, 9, 0);
    project('P--a').session('a', 'C:\\a', start, 61, 1);
    project('P--b').session('b', 'C:\\b', start, 61, 1);

    const report = await buildTimeReport({ logPaths: [logs], idleSeconds: 300 });

    expect(report.totals.totalMs).toBe(120 * MIN);
    expect(report.totals.wallClockMs).toBe(60 * MIN);
    expect(report.totals.projectCount).toBe(2);
  });

  it('ignores subagent logs nested under a session directory', async () => {
    const start = new Date(2026, 6, 15, 9, 0);
    const p = project('P--app').session('main', 'C:\\app', start, 61, 1);

    const subagents = join(p.dir, 'main', 'subagents');
    mkdirSync(subagents, { recursive: true });
    writeFileSync(
      join(subagents, 'agent-1.jsonl'),
      sessionLines('C:\\app', start, 61, 1),
      'utf-8',
    );

    const report = await buildTimeReport({ logPaths: [logs], idleSeconds: 300 });

    // Still one session, still one hour — the subagent is inside it, not beside it.
    expect(report.projects[0].sessionCount).toBe(1);
    expect(report.projects[0].totalMs).toBe(60 * MIN);
  });

  it('merges two log directories that resolve to the same project path', async () => {
    const start = new Date(2026, 6, 15, 9, 0);
    project('P--app-old').session('a', 'C:\\app', start, 31, 1);
    project('P--app').session('b', 'C:\\app', new Date(2026, 6, 16, 9, 0), 31, 1);

    const report = await buildTimeReport({ logPaths: [logs], idleSeconds: 300 });

    expect(report.projects).toHaveLength(1);
    expect(report.projects[0].path).toBe('C:\\app');
    expect(report.projects[0].sessionCount).toBe(2);
  });

  it('splits an overnight session across both days', async () => {
    const start = new Date(2026, 6, 15, 23, 30);
    project('P--app').session('a', 'C:\\app', start, 61, 1); // 23:30 -> 00:30

    const report = await buildTimeReport({ logPaths: [logs], idleSeconds: 300 });
    const days = Object.fromEntries(report.days.map(d => [d.day, d.totalMs]));

    expect(days['2026-07-15']).toBe(30 * MIN);
    expect(days['2026-07-16']).toBe(30 * MIN);
  });

  it('excludes gaps beyond the idle threshold', async () => {
    const start = new Date(2026, 6, 15, 9, 0);
    project('P--app').session('a', 'C:\\app', start, 4, 10); // 10-min steps

    const tight = await buildTimeReport({ logPaths: [logs], idleSeconds: 300 });
    const loose = await buildTimeReport({ logPaths: [logs], idleSeconds: 900 });

    expect(tight.projects).toHaveLength(0);
    expect(loose.projects[0].totalMs).toBe(30 * MIN);
  });

  it('clips to the requested range', async () => {
    const start = new Date(2026, 6, 15, 9, 0);
    project('P--app').session('a', 'C:\\app', start, 121, 1); // 09:00 -> 11:00

    const report = await buildTimeReport({
      logPaths: [logs],
      idleSeconds: 300,
      start: new Date(2026, 6, 15, 10, 0).getTime(),
      end: new Date(2026, 6, 15, 10, 30).getTime(),
    });

    expect(report.projects[0].totalMs).toBe(30 * MIN);
  });

  it('prefers the project root over a subdirectory cwd', async () => {
    const start = new Date(2026, 6, 15, 9, 0);
    const dir = join(logs, 'P--app');
    mkdirSync(dir, { recursive: true });

    const lines = [
      sessionLines('C:\\app\\packages\\web', start, 40, 1).trim(),
      sessionLines('C:\\app', new Date(start.getTime() + 40 * MIN), 10, 1).trim(),
    ].join('\n') + '\n';
    writeFileSync(join(dir, 'a.jsonl'), lines, 'utf-8');

    const report = await buildTimeReport({ logPaths: [logs], idleSeconds: 300 });
    expect(report.projects[0].path).toBe('C:\\app');
  });

  it('skips an unreadable log instead of failing the whole report', async () => {
    const start = new Date(2026, 6, 15, 9, 0);
    const p = project('P--app').session('good', 'C:\\app', start, 61, 1);

    // A directory named like a session file: opening it for read throws EISDIR.
    mkdirSync(join(p.dir, 'broken.jsonl'), { recursive: true });

    const report = await buildTimeReport({ logPaths: [logs], idleSeconds: 300 });

    expect(report.projects[0].totalMs).toBe(60 * MIN);
    expect(report.scan.filesFailed).toBe(0); // directories are filtered before reading
    expect(report.warnings).toEqual([]);
  });

  it('skips a log that keeps failing and reports the gap', async () => {
    // The real-world trigger is a container bind mount returning ENOMEM on a
    // cold scan. The rest of the report must still come through.
    const start = new Date(2026, 6, 15, 9, 0);
    project('P--app')
      .session('good', 'C:\\app', start, 61, 1)
      .session('bad', 'C:\\app', start, 61, 1);

    const report = await buildTimeReport({
      logPaths: [logs],
      idleSeconds: 300,
      scanner: async (filePath) => {
        if (filePath.endsWith('bad.jsonl')) {
          throw Object.assign(new Error('ENOMEM: not enough memory, read'), { code: 'ENOMEM' });
        }
        return scanSessionTimestamps(filePath);
      },
    });

    expect(report.projects[0].totalMs).toBe(60 * MIN);
    expect(report.projects[0].sessionCount).toBe(1);
    expect(report.scan.filesFailed).toBe(1);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toContain('bad.jsonl');
    expect(report.warnings[0]).toContain('ENOMEM');
  });

  it('retries a transient read failure before giving up', async () => {
    const start = new Date(2026, 6, 15, 9, 0);
    project('P--app').session('flaky', 'C:\\app', start, 61, 1);

    let attempts = 0;
    const report = await buildTimeReport({
      logPaths: [logs],
      idleSeconds: 300,
      scanner: async (filePath) => {
        attempts++;
        if (attempts === 1) throw new Error('ENOMEM: not enough memory, read');
        return scanSessionTimestamps(filePath);
      },
    });

    expect(attempts).toBe(2);
    expect(report.scan.filesFailed).toBe(0);
    expect(report.projects[0].totalMs).toBe(60 * MIN);
  });

  it('keeps retrying a stubbornly transient read rather than dropping the session', async () => {
    // A real cold scan of a 1.26GB log directory failed four times running on
    // some files before succeeding. Giving up early does not error — it quietly
    // omits those hours, which is worse than failing loudly.
    const start = new Date(2026, 6, 15, 9, 0);
    project('P--app').session('stubborn', 'C:\\app', start, 61, 1);

    let attempts = 0;
    const report = await buildTimeReport({
      logPaths: [logs],
      idleSeconds: 300,
      scanner: async (filePath) => {
        attempts++;
        if (attempts <= 4) throw new Error('ENOMEM: not enough memory, read');
        return scanSessionTimestamps(filePath);
      },
    });

    expect(attempts).toBe(5);
    expect(report.scan.filesFailed).toBe(0);
    expect(report.projects[0].totalMs).toBe(60 * MIN);
  });

  it('reports the first error once the retry budget is exhausted', async () => {
    const start = new Date(2026, 6, 15, 9, 0);
    project('P--app').session('hopeless', 'C:\\app', start, 61, 1);

    let attempts = 0;
    const report = await buildTimeReport({
      logPaths: [logs],
      idleSeconds: 300,
      scanner: async () => {
        attempts++;
        throw new Error('ENOMEM: not enough memory, read');
      },
    });

    expect(attempts).toBe(5); // one initial try plus the four backoff attempts
    expect(report.scan.filesFailed).toBe(1);
    expect(report.warnings[0]).toContain('ENOMEM');
  });

  it('returns an empty report when no logs exist', async () => {
    const report = await buildTimeReport({ logPaths: [join(root, 'missing')], idleSeconds: 300 });
    expect(report.projects).toEqual([]);
    expect(report.days).toEqual([]);
    expect(report.totals.totalMs).toBe(0);
  });

  it('orders projects by summed hours descending', async () => {
    const start = new Date(2026, 6, 15, 9, 0);
    project('P--small').session('a', 'C:\\small', start, 11, 1);
    project('P--big').session('b', 'C:\\big', start, 61, 1);

    const report = await buildTimeReport({ logPaths: [logs], idleSeconds: 300 });
    expect(report.projects.map(p => p.name)).toEqual(['big', 'small']);
  });

  it('ships merged intervals that sum to the project wall-clock', async () => {
    // Two sessions of the same project overlapping by 30 min: 2h summed,
    // 1.5h wall-clock, and the shipped intervals must be the merged union.
    const start = new Date(2026, 6, 15, 9, 0);
    project('P--app')
      .session('a', 'C:\\app', start, 61, 1)
      .session('b', 'C:\\app', new Date(start.getTime() + 30 * MIN), 61, 1);

    const report = await buildTimeReport({ logPaths: [logs], idleSeconds: 300 });
    const p = report.projects[0];

    expect(p.totalMs).toBe(120 * MIN);
    expect(p.wallClockMs).toBe(90 * MIN);
    expect(p.intervals).toHaveLength(1); // overlapping halves collapse into one
    expect(sumDuration(p.intervals)).toBe(p.wallClockMs);
  });

  it('lets a client re-derive wall-clock for any subset of projects', async () => {
    // This is the whole reason intervals are shipped: wall-clock is a union, so
    // a filtered total cannot be reconstructed from per-project scalars.
    const start = new Date(2026, 6, 15, 9, 0);
    project('P--a').session('a', 'C:\\a', start, 61, 1);                                   // 09:00-10:00
    project('P--b').session('b', 'C:\\b', new Date(start.getTime() + 30 * MIN), 61, 1);    // 09:30-10:30
    project('P--c').session('c', 'C:\\c', new Date(2026, 6, 15, 14, 0), 61, 1);            // 14:00-15:00

    const report = await buildTimeReport({ logPaths: [logs], idleSeconds: 300 });
    const by = Object.fromEntries(report.projects.map(p => [p.name, p]));

    const union = (names: string[]) =>
      sumDuration(mergeIntervals(names.flatMap(n => by[n].intervals)));

    // Overlapping pair: 2h summed but only 1.5h of wall-clock.
    expect(union(['a', 'b'])).toBe(90 * MIN);
    // Disjoint pair: union equals the sum.
    expect(union(['a', 'c'])).toBe(120 * MIN);
    // A single project reduces to its own wall-clock.
    expect(union(['b'])).toBe(by['b'].wallClockMs);
    // Everything matches the report-wide figure the server computed.
    expect(union(['a', 'b', 'c'])).toBe(report.totals.wallClockMs);
  });

  it('orders days ascending', async () => {
    project('P--app')
      .session('a', 'C:\\app', new Date(2026, 6, 16, 9, 0), 11, 1)
      .session('b', 'C:\\app', new Date(2026, 6, 14, 9, 0), 11, 1);

    const report = await buildTimeReport({ logPaths: [logs], idleSeconds: 300 });
    expect(report.days.map(d => d.day)).toEqual(['2026-07-14', '2026-07-16']);
  });
});
