import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildTokenReport } from '../../src/core/token-aggregator.js';
import { TokenCache } from '../../src/core/token-cache.js';
import { toLocalDayKey } from '../../src/core/time-tracker.js';

const DAY = 24 * 60 * 60_000;

interface Usage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cache5m?: number;
  cache1h?: number;
}

describe('buildTokenReport', () => {
  let root: string;
  let logs: string;
  let data: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'claude-meter-tok-'));
    logs = join(root, 'projects');
    data = join(root, 'data');
    mkdirSync(logs, { recursive: true });
    mkdirSync(data, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function midnight(daysAgo: number): Date {
    const d = new Date(Date.now() - daysAgo * DAY);
    d.setHours(10, 0, 0, 0);
    return d;
  }

  const dayKey = (daysAgo: number) => toLocalDayKey(midnight(daysAgo).getTime());

  /** Appends assistant turns carrying usage — the only lines the scanner reads. */
  function writeSession(
    dirName: string,
    file: string,
    cwd: string,
    turns: Array<{ at: Date; model: string; usage: Usage }>,
  ): void {
    const dir = join(logs, dirName);
    mkdirSync(dir, { recursive: true });
    const lines = turns.map(t => JSON.stringify({
      type: 'assistant',
      cwd,
      sessionId: file,
      timestamp: t.at.toISOString(),
      message: {
        model: t.model,
        usage: {
          input_tokens: t.usage.input ?? 0,
          output_tokens: t.usage.output ?? 0,
          cache_read_input_tokens: t.usage.cacheRead ?? 0,
          cache_creation_input_tokens: (t.usage.cache5m ?? 0) + (t.usage.cache1h ?? 0),
          cache_creation: {
            ephemeral_5m_input_tokens: t.usage.cache5m ?? 0,
            ephemeral_1h_input_tokens: t.usage.cache1h ?? 0,
          },
        },
      },
    }));
    writeFileSync(join(dir, `${file}.jsonl`), lines.join('\n') + '\n', 'utf-8');
  }

  /** Writes a subagent transcript at <project>/<session>/subagents/<name>.jsonl. */
  function writeSubagent(
    dirName: string,
    session: string,
    name: string,
    cwd: string,
    turns: Array<{ at: Date; model: string; usage: Usage }>,
  ): void {
    const dir = join(logs, dirName, session, 'subagents');
    mkdirSync(dir, { recursive: true });
    const lines = turns.map(t => JSON.stringify({
      type: 'assistant',
      cwd,
      sessionId: `${session}-${name}`,
      timestamp: t.at.toISOString(),
      message: {
        model: t.model,
        usage: { input_tokens: t.usage.input ?? 0, output_tokens: t.usage.output ?? 0 },
      },
    }));
    writeFileSync(join(dir, `${name}.jsonl`), lines.join('\n') + '\n', 'utf-8');
  }

  const build = (over: Record<string, unknown> = {}) =>
    buildTokenReport({ logPaths: [logs], ...over });

  it('attributes tokens to the project the turn ran in, not the log folder', async () => {
    // The directory name is a slug that survives a rename; cwd is the truth.
    writeSession('J--stale-old-name', 's1', 'J:\\work\\alpha', [
      { at: midnight(2), model: 'claude-opus-5', usage: { input: 100, output: 200 } },
    ]);

    const report = await build();

    expect(report.projects).toHaveLength(1);
    expect(report.projects[0].path).toBe('J:\\work\\alpha');
    expect(report.projects[0].name).toBe('alpha');
    expect(report.projects[0].usage.fresh).toBe(300);
  });

  it('merges two log directories that resolve to the same project', async () => {
    // A folder rename leaves the old slug behind with real history in it.
    writeSession('J--work-alpha', 's1', 'J:\\work\\alpha', [
      { at: midnight(2), model: 'claude-opus-5', usage: { input: 100, output: 100 } },
    ]);
    writeSession('J--work-alpha-renamed', 's2', 'J:\\work\\alpha', [
      { at: midnight(1), model: 'claude-opus-5', usage: { input: 50, output: 50 } },
    ]);

    const report = await build();

    expect(report.projects).toHaveLength(1);
    expect(report.projects[0].usage.fresh).toBe(300);
    expect(report.projects[0].sessionCount).toBe(2);
  });

  // The hours pipeline skips subagent transcripts on purpose — a subagent runs
  // inside its parent's wall-clock. Tokens are additive, so skipping them here
  // would hide the majority of real spend on an agent-heavy log directory.
  it('bills subagent spend to the parent project', async () => {
    writeSession('J--work-alpha', 'sess-1', 'J:\\work\\alpha', [
      { at: midnight(1), model: 'claude-opus-5', usage: { output: 100 } },
    ]);
    writeSubagent('J--work-alpha', 'sess-1', 'explore', 'J:\\work\\alpha', [
      { at: midnight(1), model: 'claude-sonnet-5', usage: { output: 900 } },
    ]);

    const report = await build();

    expect(report.projects).toHaveLength(1);
    expect(report.projects[0].usage.fresh).toBe(1000);
    expect(Object.keys(report.projects[0].byModel).sort()).toEqual(['claude-opus-5', 'claude-sonnet-5']);
  });

  it('does not count a subagent transcript as another session', async () => {
    writeSession('J--work-alpha', 'sess-1', 'J:\\work\\alpha', [
      { at: midnight(1), model: 'claude-opus-5', usage: { output: 100 } },
    ]);
    writeSubagent('J--work-alpha', 'sess-1', 'explore', 'J:\\work\\alpha', [
      { at: midnight(1), model: 'claude-sonnet-5', usage: { output: 900 } },
    ]);
    writeSubagent('J--work-alpha', 'sess-1', 'plan', 'J:\\work\\alpha', [
      { at: midnight(1), model: 'claude-sonnet-5', usage: { output: 50 } },
    ]);

    const report = await build();

    expect(report.projects[0].sessionCount).toBe(1);
  });

  // A session file spanning two months must not report itself against a range
  // it only touches at the edge.
  it('counts only the sessions that ran inside the range', async () => {
    writeSession('J--work-alpha', 'old', 'J:\\work\\alpha', [
      { at: midnight(40), model: 'claude-opus-5', usage: { output: 10 } },
    ]);
    writeSession('J--work-alpha', 'recent', 'J:\\work\\alpha', [
      { at: midnight(1), model: 'claude-opus-5', usage: { output: 10 } },
    ]);

    const wide = await build();
    const narrow = await build({ start: Date.now() - 3 * DAY, end: Date.now() });

    expect(wide.projects[0].sessionCount).toBe(2);
    expect(narrow.projects[0].sessionCount).toBe(1);
  });

  it('splits usage across days by local midnight', async () => {
    writeSession('J--work-alpha', 's1', 'J:\\work\\alpha', [
      { at: midnight(2), model: 'claude-opus-5', usage: { input: 10, output: 10 } },
      { at: midnight(1), model: 'claude-opus-5', usage: { input: 30, output: 30 } },
    ]);

    const report = await build();
    const byDay = report.projects[0].byDay;

    expect(byDay[dayKey(2)].fresh).toBe(20);
    expect(byDay[dayKey(1)].fresh).toBe(60);
    expect(report.days.map(d => d.day)).toEqual([dayKey(2), dayKey(1)]);
  });

  it('prices each model at its own rate rather than pricing the sum once', async () => {
    // Summing opus and haiku tokens before costing would bill haiku as opus.
    writeSession('J--work-alpha', 's1', 'J:\\work\\alpha', [
      { at: midnight(1), model: 'claude-opus-5', usage: { output: 1_000_000 } },
    ]);
    writeSession('J--work-beta', 's2', 'J:\\work\\beta', [
      { at: midnight(1), model: 'claude-haiku-4-5-20251001', usage: { output: 1_000_000 } },
    ]);

    const report = await build();
    const alpha = report.projects.find(p => p.name === 'alpha')!;
    const beta = report.projects.find(p => p.name === 'beta')!;

    expect(alpha.usage.fresh).toBe(beta.usage.fresh);
    expect(alpha.usage.costUsd).toBeGreaterThan(beta.usage.costUsd);
    expect(report.totals.costUsd).toBeCloseTo(alpha.usage.costUsd + beta.usage.costUsd, 6);
  });

  it('counts cache reads in the full total but not the fresh total', async () => {
    writeSession('J--work-alpha', 's1', 'J:\\work\\alpha', [
      { at: midnight(1), model: 'claude-opus-5', usage: { input: 10, output: 20, cacheRead: 900, cache5m: 70 } },
    ]);

    const report = await build();
    const usage = report.projects[0].usage;

    expect(usage.fresh).toBe(30);
    expect(usage.full).toBe(1000);
    expect(usage.cacheRead).toBe(900);
  });

  it('restricts the report to the requested range', async () => {
    writeSession('J--work-alpha', 's1', 'J:\\work\\alpha', [
      { at: midnight(9), model: 'claude-opus-5', usage: { input: 1000, output: 1000 } },
      { at: midnight(1), model: 'claude-opus-5', usage: { input: 5, output: 5 } },
    ]);

    const report = await build({ start: Date.now() - 2 * DAY, end: Date.now() });

    expect(report.totals.fresh).toBe(10);
    expect(report.days).toHaveLength(1);
    expect(report.days[0].day).toBe(dayKey(1));
  });

  // A range starting at 09:00 must still include the turns taken at 08:00 that
  // same day, or "today" silently loses the morning's work.
  it('includes the whole first day when the range starts mid-morning', async () => {
    const early = midnight(0);
    early.setHours(2, 0, 0, 0);
    writeSession('J--work-alpha', 's1', 'J:\\work\\alpha', [
      { at: early, model: 'claude-opus-5', usage: { input: 7, output: 7 } },
    ]);

    const noon = new Date();
    noon.setHours(12, 0, 0, 0);
    const report = await build({ start: noon.getTime(), end: Date.now() + DAY });

    expect(report.totals.fresh).toBe(14);
  });

  it('drops a project that has no usage inside the range', async () => {
    writeSession('J--work-alpha', 's1', 'J:\\work\\alpha', [
      { at: midnight(30), model: 'claude-opus-5', usage: { input: 100, output: 100 } },
    ]);
    writeSession('J--work-beta', 's2', 'J:\\work\\beta', [
      { at: midnight(1), model: 'claude-opus-5', usage: { input: 1, output: 1 } },
    ]);

    const report = await build({ start: Date.now() - 3 * DAY, end: Date.now() });

    expect(report.projects.map(p => p.name)).toEqual(['beta']);
  });

  it('ranks projects by cost, not by token count', async () => {
    // Haiku output is $5/M against opus at $25/M, so 3M cheap tokens are worth
    // less than 1M expensive ones while looking far larger on a token bar.
    writeSession('J--work-cheap', 's1', 'J:\\work\\cheap', [
      { at: midnight(1), model: 'claude-haiku-4-5-20251001', usage: { output: 3_000_000 } },
    ]);
    writeSession('J--work-pricey', 's2', 'J:\\work\\pricey', [
      { at: midnight(1), model: 'claude-opus-5', usage: { output: 1_000_000 } },
    ]);

    const report = await build();

    expect(report.projects[0].name).toBe('pricey');
    expect(report.projects[0].usage.fresh).toBeLessThan(report.projects[1].usage.fresh);
  });

  it('breaks a day down by the projects that contributed to it', async () => {
    writeSession('J--work-alpha', 's1', 'J:\\work\\alpha', [
      { at: midnight(1), model: 'claude-opus-5', usage: { output: 300 } },
    ]);
    writeSession('J--work-beta', 's2', 'J:\\work\\beta', [
      { at: midnight(1), model: 'claude-opus-5', usage: { output: 100 } },
    ]);

    const report = await build();
    const day = report.days[0];

    expect(day.usage.fresh).toBe(400);
    expect(day.projects.map(p => p.name)).toEqual(['alpha', 'beta']);
    expect(day.projects[0].fresh).toBe(300);
  });

  it('omits synthetic placeholder turns from the model breakdown', async () => {
    writeSession('J--work-alpha', 's1', 'J:\\work\\alpha', [
      { at: midnight(1), model: 'claude-opus-5', usage: { output: 100 } },
      { at: midnight(1), model: '<synthetic>', usage: {} },
    ]);

    const report = await build();

    expect(Object.keys(report.byModel)).toEqual(['claude-opus-5']);
    expect(report.pricing.guessedModels).toEqual([]);
  });

  it('names any model the bundled table could not price', async () => {
    writeSession('J--work-alpha', 's1', 'J:\\work\\alpha', [
      { at: midnight(1), model: 'claude-unreleased-9', usage: { output: 100 } },
    ]);

    const report = await build();

    expect(report.pricing.guessedModels).toEqual(['claude-unreleased-9']);
    expect(report.byModel['claude-unreleased-9'].fallback).toBe(true);
  });

  // Claude Code deletes its own transcripts as they age out, and it can do so
  // while a scan is walking the directory it just enumerated. One vanished log
  // must cost its own numbers and nothing else.
  it('reports a log that vanished mid-scan instead of losing the whole report', async () => {
    writeSession('J--work-alpha', 's1', 'J:\\work\\alpha', [
      { at: midnight(1), model: 'claude-opus-5', usage: { output: 100 } },
    ]);
    writeSession('J--work-beta', 'doomed', 'J:\\work\\beta', [
      { at: midnight(1), model: 'claude-opus-5', usage: { output: 500 } },
    ]);

    const report = await build({
      onProgress: () => rmSync(join(logs, 'J--work-beta', 'doomed.jsonl'), { force: true }),
    });

    expect(report.totals.fresh).toBe(100);
    expect(report.scan.filesFailed).toBe(1);
    expect(report.warnings.join(' ')).toMatch(/doomed\.jsonl/);
  });

  describe('with a token cache', () => {
    const openCache = () => {
      const c = new TokenCache(data);
      c.load();
      return c;
    };

    it('reuses an unchanged file instead of rescanning it', async () => {
      writeSession('J--work-alpha', 's1', 'J:\\work\\alpha', [
        { at: midnight(1), model: 'claude-opus-5', usage: { input: 10, output: 20 } },
      ]);

      const first = await build({ cache: openCache() });
      expect(first.scan.filesFromCache).toBe(0);

      const second = await build({ cache: openCache() });
      expect(second.scan.filesFromCache).toBe(1);
      expect(second.totals.fresh).toBe(first.totals.fresh);
    });

    // The whole point of caching the per-day breakdown: one scan answers every
    // range, so switching from "all time" to "yesterday" costs nothing.
    it('answers a different range from cache without rescanning', async () => {
      writeSession('J--work-alpha', 's1', 'J:\\work\\alpha', [
        { at: midnight(9), model: 'claude-opus-5', usage: { output: 1000 } },
        { at: midnight(1), model: 'claude-opus-5', usage: { output: 7 } },
      ]);

      await build({ cache: openCache() });
      const narrow = await build({
        cache: openCache(),
        start: Date.now() - 2 * DAY,
        end: Date.now(),
      });

      expect(narrow.scan.filesFromCache).toBe(1);
      expect(narrow.totals.fresh).toBe(7);
    });

    it('rescans a file that grew since it was cached', async () => {
      writeSession('J--work-alpha', 's1', 'J:\\work\\alpha', [
        { at: midnight(1), model: 'claude-opus-5', usage: { output: 10 } },
      ]);
      await build({ cache: openCache() });

      writeSession('J--work-alpha', 's1', 'J:\\work\\alpha', [
        { at: midnight(1), model: 'claude-opus-5', usage: { output: 10 } },
        { at: midnight(1), model: 'claude-opus-5', usage: { output: 90 } },
      ]);

      const report = await build({ cache: openCache() });

      expect(report.scan.filesFromCache).toBe(0);
      expect(report.totals.fresh).toBe(100);
    });

    it('forgets files that no longer exist', async () => {
      writeSession('J--work-alpha', 's1', 'J:\\work\\alpha', [
        { at: midnight(1), model: 'claude-opus-5', usage: { output: 10 } },
      ]);
      await build({ cache: openCache() });

      rmSync(join(logs, 'J--work-alpha'), { recursive: true, force: true });
      await build({ cache: openCache() });

      const onDisk = readFileSync(join(data, 'token-cache.ndjson'), 'utf-8');
      expect(onDisk).not.toMatch(/s1\.jsonl/);
    });

    it('leaves the timeline cache alone when sweeping its own temp files', async () => {
      writeFileSync(join(data, 'timeline-deadbeef.tmp'), 'x', 'utf-8');
      writeFileSync(join(data, 'token-deadbeef.tmp'), 'x', 'utf-8');

      const removed = openCache().sweepTempFiles();

      expect(removed).toBe(1);
      expect(readFileSync(join(data, 'timeline-deadbeef.tmp'), 'utf-8')).toBe('x');
    });
  });
});
