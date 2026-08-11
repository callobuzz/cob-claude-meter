import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildTimeReport } from '../../src/core/time-aggregator.js';
import { ALGO_VERSION, DayArchive, startOfToday } from '../../src/core/day-archive.js';
import { toLocalDayKey } from '../../src/core/time-tracker.js';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/**
 * The archive exists because Claude Code deletes its own transcripts once they
 * age past `cleanupPeriodDays`. Every test here therefore ends by deleting logs
 * and asking whether the hours survived.
 */
describe('buildTimeReport with a day archive', () => {
  let root: string;
  let logs: string;
  let data: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'claude-meter-hist-'));
    logs = join(root, 'projects');
    data = join(root, 'data');
    mkdirSync(logs, { recursive: true });
    mkdirSync(data, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** A date `daysAgo` back at `hour`, so days are always finished ones. */
  function at(daysAgo: number, hour: number): Date {
    const d = new Date(startOfToday() - daysAgo * DAY);
    d.setHours(hour, 0, 0, 0);
    return d;
  }

  const dayKey = (daysAgo: number) => toLocalDayKey(startOfToday() - daysAgo * DAY);

  function writeSession(dirName: string, file: string, cwd: string, start: Date, minutes: number): string {
    const dir = join(logs, dirName);
    mkdirSync(dir, { recursive: true });
    const lines: string[] = [];
    for (let i = 0; i <= minutes; i++) {
      lines.push(JSON.stringify({
        type: i % 2 === 0 ? 'user' : 'assistant',
        cwd,
        timestamp: new Date(start.getTime() + i * MIN).toISOString(),
        sessionId: file,
      }));
    }
    writeFileSync(join(dir, `${file}.jsonl`), lines.join('\n') + '\n', 'utf-8');
    return dir;
  }

  function openArchive(): DayArchive {
    const a = new DayArchive(data);
    a.load();
    return a;
  }

  const build = (archive?: DayArchive, over: Record<string, unknown> = {}) =>
    buildTimeReport({ logPaths: [logs], idleSeconds: 300, archive, ...over });

  it('serves a day whose logs have been deleted', async () => {
    writeSession('P--app', 'a', 'C:\\work\\app', at(3, 9), 60);

    const first = await build(openArchive());
    expect(first.projects[0].totalMs).toBe(60 * MIN);
    expect(first.scan.daysRestored).toBe(0);

    rmSync(join(logs, 'P--app'), { recursive: true, force: true });

    const after = await build(openArchive());
    expect(after.projects).toHaveLength(1);
    expect(after.projects[0].totalMs).toBe(60 * MIN);
    expect(after.projects[0].name).toBe('app');
    expect(after.scan.daysRestored).toBe(1);
  });

  it('loses that day without an archive, which is the problem being solved', async () => {
    writeSession('P--app', 'a', 'C:\\work\\app', at(3, 9), 60);
    await build(openArchive());

    rmSync(join(logs, 'P--app'), { recursive: true, force: true });

    const after = await build();
    expect(after.projects).toHaveLength(0);
    expect(after.totals.totalMs).toBe(0);
  });

  it('does not double a day that the logs still produce', async () => {
    writeSession('P--app', 'a', 'C:\\work\\app', at(3, 9), 60);

    await build(openArchive());
    const second = await build(openArchive());

    expect(second.projects[0].totalMs).toBe(60 * MIN);
    expect(second.scan.daysRestored).toBe(0);
  });

  it('never archives today, which is still being written to', async () => {
    const todayMorning = new Date();
    todayMorning.setHours(0, 30, 0, 0);
    writeSession('P--app', 'a', 'C:\\work\\app', todayMorning, 30);

    await build(openArchive());

    expect(openArchive().days()).not.toContain(toLocalDayKey(Date.now()));
  });

  it('does not archive a day the range only half covers', async () => {
    writeSession('P--app', 'a', 'C:\\work\\app', at(3, 9), 60);

    // Range opens at 08:00 on the day in question — the morning is inside it,
    // but the day as a whole is not.
    await build(openArchive(), { start: at(3, 8).getTime(), end: Date.now() });

    expect(openArchive().get(dayKey(3), 'C:\\work\\app')).toBeNull();
  });

  it('keeps the fuller number when logs disappear one session at a time', async () => {
    // Two terminals, two hours summed. Then Claude Code expires one transcript.
    writeSession('P--app', 'a', 'C:\\work\\app', at(4, 9), 60);
    writeSession('P--app', 'b', 'C:\\work\\app', at(4, 14), 60);

    await build(openArchive());
    expect(openArchive().get(dayKey(4), 'C:\\work\\app')?.totalMs).toBe(120 * MIN);

    rmSync(join(logs, 'P--app', 'b.jsonl'), { force: true });
    const partial = await build(openArchive());
    // The logs are still the source of truth while they exist.
    expect(partial.projects[0].totalMs).toBe(60 * MIN);
    // But the record must not be worn down to match them.
    expect(openArchive().get(dayKey(4), 'C:\\work\\app')?.totalMs).toBe(120 * MIN);

    rmSync(join(logs, 'P--app'), { recursive: true, force: true });
    const restored = await build(openArchive());
    expect(restored.projects[0].totalMs).toBe(120 * MIN);
  });

  it('still records a day that grew, so corrections upward are not blocked', async () => {
    writeSession('P--app', 'a', 'C:\\work\\app', at(4, 9), 60);
    await build(openArchive());

    writeSession('P--app', 'b', 'C:\\work\\app', at(4, 14), 60);
    await build(openArchive());

    expect(openArchive().get(dayKey(4), 'C:\\work\\app')?.totalMs).toBe(120 * MIN);
  });

  it('merges restored days into a project whose other days still have logs', async () => {
    writeSession('P--app', 'old', 'C:\\work\\app', at(5, 9), 60);
    writeSession('P--app', 'new', 'C:\\work\\app', at(2, 9), 60);

    await build(openArchive());
    rmSync(join(logs, 'P--app', 'old.jsonl'), { force: true });

    const after = await build(openArchive());
    expect(after.projects).toHaveLength(1);
    expect(after.projects[0].totalMs).toBe(120 * MIN);
    expect(after.projects[0].activeDays).toBe(2);
    expect(after.projects[0].byDay[dayKey(5)]).toBe(60 * MIN);
    expect(after.scan.daysRestored).toBe(1);
  });

  it('keeps wall-clock a union, not a sum, across restored and live days', async () => {
    // Two projects worked on at the same hour of the same day.
    writeSession('P--a', 'a', 'C:\\work\\a', at(3, 9), 60);
    writeSession('P--b', 'b', 'C:\\work\\b', at(3, 9), 60);

    const before = await build(openArchive());
    expect(before.totals.totalMs).toBe(120 * MIN);
    expect(before.totals.wallClockMs).toBe(60 * MIN);

    rmSync(join(logs, 'P--a'), { recursive: true, force: true });

    const after = await build(openArchive());
    expect(after.totals.totalMs).toBe(120 * MIN);
    // The overlap has to survive the round trip; storing only totals could not
    // have reproduced this.
    expect(after.totals.wallClockMs).toBe(60 * MIN);
  });

  it('puts restored days back into the day breakdown, not just the project rollup', async () => {
    writeSession('P--app', 'a', 'C:\\work\\app', at(3, 9), 60);
    await build(openArchive());
    rmSync(join(logs, 'P--app'), { recursive: true, force: true });

    const after = await build(openArchive());
    const day = after.days.find(d => d.day === dayKey(3));

    expect(day?.totalMs).toBe(60 * MIN);
    expect(day?.wallClockMs).toBe(60 * MIN);
    expect(day?.projects[0].name).toBe('app');
  });

  it('leaves restored days out of a range that does not reach them', async () => {
    writeSession('P--app', 'a', 'C:\\work\\app', at(9, 9), 60);
    await build(openArchive());
    rmSync(join(logs, 'P--app'), { recursive: true, force: true });

    const after = await build(openArchive(), {
      start: startOfToday() - 3 * DAY,
      end: Date.now(),
    });

    expect(after.projects).toHaveLength(0);
    expect(after.scan.daysRestored).toBe(0);
  });

  it('says so when a restored day was measured at another threshold', async () => {
    writeSession('P--app', 'a', 'C:\\work\\app', at(3, 9), 60);
    await build(openArchive(), { idleSeconds: 300 });
    rmSync(join(logs, 'P--app'), { recursive: true, force: true });

    const after = await build(openArchive(), { idleSeconds: 600 });

    expect(after.scan.daysRestored).toBe(1);
    expect(after.warnings.join(' ')).toMatch(/different idle threshold/i);
  });

  it('does not warn when the restored days match the current settings', async () => {
    writeSession('P--app', 'a', 'C:\\work\\app', at(3, 9), 60);
    await build(openArchive());
    rmSync(join(logs, 'P--app'), { recursive: true, force: true });

    const after = await build(openArchive());
    expect(after.warnings).toHaveLength(0);
  });

  it('stamps the rules an entry was computed under, so they can be recognised later', async () => {
    writeSession('P--app', 'a', 'C:\\work\\app', at(3, 9), 60);
    await build(openArchive());

    expect(openArchive().get(dayKey(3), 'C:\\work\\app')?.algo).toBe(ALGO_VERSION);
  });

  it('warns instead of failing when the archive cannot be written', async () => {
    writeSession('P--app', 'a', 'C:\\work\\app', at(3, 9), 60);
    writeFileSync(join(root, 'blocker'), 'x', 'utf-8');

    const report = await build(new DayArchive(join(root, 'blocker', 'nested')));

    expect(report.projects[0].totalMs).toBe(60 * MIN);
    expect(report.warnings.join(' ')).toMatch(/archive could not be saved/i);
  });

  it('splits a session running past midnight into two archived days', async () => {
    writeSession('P--app', 'night', 'C:\\work\\app', at(4, 23), 120);

    await build(openArchive());
    const archive = openArchive();

    expect(archive.get(dayKey(4), 'C:\\work\\app')?.totalMs).toBe(60 * MIN);
    expect(archive.get(dayKey(3), 'C:\\work\\app')?.totalMs).toBe(60 * MIN);
  });
});
