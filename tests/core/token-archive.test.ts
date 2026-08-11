import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildTokenReport } from '../../src/core/token-aggregator.js';
import { TokenArchive, TOKEN_ALGO_VERSION } from '../../src/core/token-archive.js';
import { startOfToday } from '../../src/core/day-archive.js';
import { toLocalDayKey } from '../../src/core/time-tracker.js';

const DAY = 24 * 60 * 60_000;

/**
 * Claude Code deletes its own transcripts once they age past
 * `cleanupPeriodDays`. Every test here therefore ends by deleting logs and
 * asking whether the spend survived.
 */
describe('buildTokenReport with a token archive', () => {
  let root: string;
  let logs: string;
  let data: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'claude-meter-tokarch-'));
    logs = join(root, 'projects');
    data = join(root, 'data');
    mkdirSync(logs, { recursive: true });
    mkdirSync(data, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** A finished day, so the archive will accept it. */
  function at(daysAgo: number, hour = 10): Date {
    const d = new Date(startOfToday() - daysAgo * DAY);
    d.setHours(hour, 0, 0, 0);
    return d;
  }

  const dayKey = (daysAgo: number) => toLocalDayKey(startOfToday() - daysAgo * DAY);

  function writeSession(
    dirName: string,
    sessionId: string,
    cwd: string,
    turns: Array<{ at: Date; model?: string; output: number }>,
  ): void {
    const dir = join(logs, dirName);
    mkdirSync(dir, { recursive: true });
    const lines = turns.map(t => JSON.stringify({
      type: 'assistant',
      cwd,
      sessionId,
      timestamp: t.at.toISOString(),
      message: {
        model: t.model ?? 'claude-opus-5',
        usage: { input_tokens: 0, output_tokens: t.output },
      },
    }));
    writeFileSync(join(dir, `${sessionId}.jsonl`), lines.join('\n') + '\n', 'utf-8');
  }

  function openArchive(): TokenArchive {
    const a = new TokenArchive(data);
    a.load();
    return a;
  }

  const build = (archive?: TokenArchive, over: Record<string, unknown> = {}) =>
    buildTokenReport({ logPaths: [logs], archive, ...over });

  it('serves a day whose logs have been deleted', async () => {
    writeSession('J--work-alpha', 's1', 'J:\\work\\alpha', [
      { at: at(3), output: 1000 },
    ]);

    const first = await build(openArchive());
    expect(first.totals.fresh).toBe(1000);
    expect(first.scan.daysRestored).toBe(0);

    rmSync(join(logs, 'J--work-alpha'), { recursive: true, force: true });

    const after = await build(openArchive());
    expect(after.totals.fresh).toBe(1000);
    expect(after.totals.costUsd).toBeCloseTo(first.totals.costUsd, 8);
    expect(after.scan.daysRestored).toBe(1);
    expect(after.projects[0].name).toBe('alpha');
  });

  it('keeps the model breakdown of a restored day', async () => {
    writeSession('J--work-alpha', 's1', 'J:\\work\\alpha', [
      { at: at(3), model: 'claude-opus-5', output: 1000 },
      { at: at(3), model: 'claude-sonnet-5', output: 5000 },
    ]);

    await build(openArchive());
    rmSync(join(logs, 'J--work-alpha'), { recursive: true, force: true });
    const after = await build(openArchive());

    expect(Object.keys(after.byModel).sort()).toEqual(['claude-opus-5', 'claude-sonnet-5']);
    expect(after.projects[0].byModel['claude-sonnet-5'].fresh).toBe(5000);
  });

  it('never archives today, which is still being written to', async () => {
    writeSession('J--work-alpha', 's1', 'J:\\work\\alpha', [
      { at: at(0), output: 500 },
    ]);

    await build(openArchive());

    const archive = openArchive();
    expect(archive.days()).not.toContain(dayKey(0));
    expect(archive.size).toBe(0);
  });

  // Sessions are deleted one at a time, so a day at the edge of the retention
  // window recomputes smaller and smaller. Recording that decay would drain the
  // history this file exists to protect.
  it('keeps the fuller number when logs disappear one session at a time', async () => {
    // Two sessions on one day. Then Claude Code expires one transcript.
    writeSession('J--work-alpha', 's1', 'J:\\work\\alpha', [{ at: at(3), output: 1000 }]);
    writeSession('J--work-alpha', 's2', 'J:\\work\\alpha', [{ at: at(3), output: 3000 }]);

    const full = await build(openArchive());
    expect(full.totals.fresh).toBe(4000);
    expect(openArchive().get(dayKey(3), 'J:\\work\\alpha')!.sessionCount).toBe(2);

    rmSync(join(logs, 'J--work-alpha', 's2.jsonl'), { force: true });
    const partial = await build(openArchive());

    // The logs are still the source of truth while they exist...
    expect(partial.totals.fresh).toBe(1000);
    // ...but the record must not be worn down to match them.
    const entry = openArchive().get(dayKey(3), 'J:\\work\\alpha')!;
    expect(entry.models['claude-opus-5'][1]).toBe(4000);
    expect(entry.sessionCount).toBe(2);

    // Once the logs are gone entirely, the full day comes back.
    rmSync(join(logs, 'J--work-alpha'), { recursive: true, force: true });
    const restored = await build(openArchive());
    expect(restored.totals.fresh).toBe(4000);
    expect(restored.projects[0].sessionCount).toBe(2);
  });

  it('still records a day that grew', async () => {
    writeSession('J--work-alpha', 's1', 'J:\\work\\alpha', [{ at: at(3), output: 1000 }]);
    await build(openArchive());

    writeSession('J--work-alpha', 's1', 'J:\\work\\alpha', [
      { at: at(3), output: 1000 },
      { at: at(3, 14), output: 9000 },
    ]);
    const grown = await build(openArchive());

    expect(grown.totals.fresh).toBe(10_000);
    rmSync(join(logs, 'J--work-alpha'), { recursive: true, force: true });
    expect((await build(openArchive())).totals.fresh).toBe(10_000);
  });

  it('does not double-count a day the logs still describe', async () => {
    writeSession('J--work-alpha', 's1', 'J:\\work\\alpha', [{ at: at(3), output: 1000 }]);

    await build(openArchive());
    const second = await build(openArchive());

    expect(second.totals.fresh).toBe(1000);
    expect(second.scan.daysRestored).toBe(0);
  });

  it('leaves a half-covered day out rather than restoring a fraction of it', async () => {
    writeSession('J--work-alpha', 's1', 'J:\\work\\alpha', [{ at: at(3), output: 1000 }]);
    await build(openArchive());
    rmSync(join(logs, 'J--work-alpha'), { recursive: true, force: true });

    // A range that begins at midday on the archived day covers only half of it.
    const midday = new Date(startOfToday() - 3 * DAY);
    midday.setHours(12, 0, 0, 0);
    const partial = await build(openArchive(), { start: midday.getTime(), end: Date.now() });

    expect(partial.scan.daysRestored).toBe(0);
    expect(partial.totals.fresh).toBe(0);
  });

  it('prices a restored day with the current table, not a frozen figure', async () => {
    writeSession('J--work-alpha', 's1', 'J:\\work\\alpha', [{ at: at(3), output: 1_000_000 }]);
    await build(openArchive());
    rmSync(join(logs, 'J--work-alpha'), { recursive: true, force: true });

    // Storing tokens rather than dollars is what makes an override apply to
    // history as well as to days the logs still describe.
    const restored = await build(openArchive(), {
      overrides: { 'claude-opus-5': { output: 100 } },
    });

    expect(restored.totals.fresh).toBe(1_000_000);
    expect(restored.totals.costUsd).toBeCloseTo(100, 6);
  });

  it('reports a failed archive write instead of looking healthy', async () => {
    writeSession('J--work-alpha', 's1', 'J:\\work\\alpha', [{ at: at(3), output: 1000 }]);

    const archive = openArchive();
    (archive as unknown as { save: () => unknown }).save = () =>
      ({ ok: false, reason: 'disk full' });

    const report = await build(archive);

    expect(report.warnings.join(' ')).toMatch(/Token archive could not be saved \(disk full\)/);
    expect(report.totals.fresh).toBe(1000);
  });

  it('records the attribution rules each day was computed under', async () => {
    writeSession('J--work-alpha', 's1', 'J:\\work\\alpha', [{ at: at(3), output: 1000 }]);
    await build(openArchive());

    const entry = openArchive().get(dayKey(3), 'J:\\work\\alpha')!;
    expect(entry.algo).toBe(TOKEN_ALGO_VERSION);
    expect(entry.models['claude-opus-5'][1]).toBe(1000);
  });

  it('leaves the day archive alone when sweeping its own temp files', async () => {
    writeFileSync(join(data, 'day-archive-deadbeef.tmp'), 'x', 'utf-8');
    writeFileSync(join(data, 'token-archive-deadbeef.tmp'), 'x', 'utf-8');

    expect(openArchive().sweepTempFiles()).toBe(1);
  });
});
