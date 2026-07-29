import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildTimeReport } from '../../src/core/time-aggregator.js';
import { scanSessionTimestamps } from '../../src/core/time-tracker.js';

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
      .session('a', 'J:\\app', start, 61, 1)
      .session('b', 'J:\\app', start, 61, 1);

    const report = await buildTimeReport({ logPaths: [logs], idleSeconds: 300 });

    expect(report.projects).toHaveLength(1);
    expect(report.projects[0].totalMs).toBe(120 * MIN);
    expect(report.projects[0].wallClockMs).toBe(60 * MIN);
    expect(report.projects[0].sessionCount).toBe(2);
  });

  it('reports summed total above wall-clock across different projects', async () => {
    const start = new Date(2026, 6, 15, 9, 0);
    project('P--a').session('a', 'J:\\a', start, 61, 1);
    project('P--b').session('b', 'J:\\b', start, 61, 1);

    const report = await buildTimeReport({ logPaths: [logs], idleSeconds: 300 });

    expect(report.totals.totalMs).toBe(120 * MIN);
    expect(report.totals.wallClockMs).toBe(60 * MIN);
    expect(report.totals.projectCount).toBe(2);
  });

  it('ignores subagent logs nested under a session directory', async () => {
    const start = new Date(2026, 6, 15, 9, 0);
    const p = project('P--app').session('main', 'J:\\app', start, 61, 1);

    const subagents = join(p.dir, 'main', 'subagents');
    mkdirSync(subagents, { recursive: true });
    writeFileSync(
      join(subagents, 'agent-1.jsonl'),
      sessionLines('J:\\app', start, 61, 1),
      'utf-8',
    );

    const report = await buildTimeReport({ logPaths: [logs], idleSeconds: 300 });

    // Still one session, still one hour — the subagent is inside it, not beside it.
    expect(report.projects[0].sessionCount).toBe(1);
    expect(report.projects[0].totalMs).toBe(60 * MIN);
  });

  it('merges two log directories that resolve to the same project path', async () => {
    const start = new Date(2026, 6, 15, 9, 0);
    project('P--app-old').session('a', 'J:\\app', start, 31, 1);
    project('P--app').session('b', 'J:\\app', new Date(2026, 6, 16, 9, 0), 31, 1);

    const report = await buildTimeReport({ logPaths: [logs], idleSeconds: 300 });

    expect(report.projects).toHaveLength(1);
    expect(report.projects[0].path).toBe('J:\\app');
    expect(report.projects[0].sessionCount).toBe(2);
  });

  it('splits an overnight session across both days', async () => {
    const start = new Date(2026, 6, 15, 23, 30);
    project('P--app').session('a', 'J:\\app', start, 61, 1); // 23:30 -> 00:30

    const report = await buildTimeReport({ logPaths: [logs], idleSeconds: 300 });
    const days = Object.fromEntries(report.days.map(d => [d.day, d.totalMs]));

    expect(days['2026-07-15']).toBe(30 * MIN);
    expect(days['2026-07-16']).toBe(30 * MIN);
  });

  it('excludes gaps beyond the idle threshold', async () => {
    const start = new Date(2026, 6, 15, 9, 0);
    project('P--app').session('a', 'J:\\app', start, 4, 10); // 10-min steps

    const tight = await buildTimeReport({ logPaths: [logs], idleSeconds: 300 });
    const loose = await buildTimeReport({ logPaths: [logs], idleSeconds: 900 });

    expect(tight.projects).toHaveLength(0);
    expect(loose.projects[0].totalMs).toBe(30 * MIN);
  });

  it('clips to the requested range', async () => {
    const start = new Date(2026, 6, 15, 9, 0);
    project('P--app').session('a', 'J:\\app', start, 121, 1); // 09:00 -> 11:00

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
      sessionLines('J:\\app\\packages\\web', start, 40, 1).trim(),
      sessionLines('J:\\app', new Date(start.getTime() + 40 * MIN), 10, 1).trim(),
    ].join('\n') + '\n';
    writeFileSync(join(dir, 'a.jsonl'), lines, 'utf-8');

    const report = await buildTimeReport({ logPaths: [logs], idleSeconds: 300 });
    expect(report.projects[0].path).toBe('J:\\app');
  });

  it('skips an unreadable log instead of failing the whole report', async () => {
    const start = new Date(2026, 6, 15, 9, 0);
    const p = project('P--app').session('good', 'J:\\app', start, 61, 1);

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
      .session('good', 'J:\\app', start, 61, 1)
      .session('bad', 'J:\\app', start, 61, 1);

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
    project('P--app').session('flaky', 'J:\\app', start, 61, 1);

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

  it('returns an empty report when no logs exist', async () => {
    const report = await buildTimeReport({ logPaths: [join(root, 'missing')], idleSeconds: 300 });
    expect(report.projects).toEqual([]);
    expect(report.days).toEqual([]);
    expect(report.totals.totalMs).toBe(0);
  });

  it('orders projects by summed hours descending', async () => {
    const start = new Date(2026, 6, 15, 9, 0);
    project('P--small').session('a', 'J:\\small', start, 11, 1);
    project('P--big').session('b', 'J:\\big', start, 61, 1);

    const report = await buildTimeReport({ logPaths: [logs], idleSeconds: 300 });
    expect(report.projects.map(p => p.name)).toEqual(['big', 'small']);
  });

  it('orders days ascending', async () => {
    project('P--app')
      .session('a', 'J:\\app', new Date(2026, 6, 16, 9, 0), 11, 1)
      .session('b', 'J:\\app', new Date(2026, 6, 14, 9, 0), 11, 1);

    const report = await buildTimeReport({ logPaths: [logs], idleSeconds: 300 });
    expect(report.days.map(d => d.day)).toEqual(['2026-07-14', '2026-07-16']);
  });
});
