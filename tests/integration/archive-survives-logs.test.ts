import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TagStore } from '../../src/core/tag-store.js';
import { TimelineCache } from '../../src/core/timeline-cache.js';
import { DayArchive } from '../../src/core/day-archive.js';
import { startDashboardServer } from '../../src/server/server.js';
import { invalidateReportCache } from '../../src/server/api.js';

/**
 * The archive, end to end through the HTTP server.
 *
 * Claude Code deletes its own transcripts on a retention timer, and everything
 * this tool reports is derived from them — so the interesting question is not
 * whether the numbers are right while the logs exist, but whether they are
 * still there afterwards. This test deletes the logs out from under a running
 * server and asks it again.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

let logRoot: string;
let dataDir: string;
let baseUrl: string;
let stop: () => Promise<void>;

function localMidnight(daysAgo: number): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime() - daysAgo * DAY;
}

const iso = (ms: number) => new Date(ms).toISOString();

function writeSession(projectDir: string, sessionId: string, cwd: string, start: number, durationMs: number): void {
  mkdirSync(projectDir, { recursive: true });
  const lines = [
    JSON.stringify({ type: 'user', origin: { kind: 'human' }, message: { content: 'go' }, cwd, timestamp: iso(start) }),
    JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs, cwd, timestamp: iso(start + durationMs) }),
  ];
  writeFileSync(join(projectDir, `${sessionId}.jsonl`), lines.join('\n'), 'utf-8');
}

async function get(path: string): Promise<any> {
  const res = await fetch(`${baseUrl}${path}`);
  return JSON.parse(await res.text());
}

beforeAll(async () => {
  logRoot = mkdtempSync(join(tmpdir(), 'meter-arch-logs-'));
  dataDir = mkdtempSync(join(tmpdir(), 'meter-arch-data-'));

  writeSession(join(logRoot, 'proj-alpha'), 'alpha-1', 'C:\\work\\alpha', localMidnight(3) + 9 * HOUR, HOUR);
  writeSession(join(logRoot, 'proj-beta'), 'beta-1', 'C:\\work\\beta', localMidnight(2) + 14 * HOUR, 30 * MIN);

  const archive = new DayArchive(dataDir);
  archive.load();

  const started = await startDashboardServer({
    port: 0,
    host: '127.0.0.1',
    logPaths: [logRoot],
    tags: new TagStore(dataDir).load(),
    cache: new TimelineCache(dataDir),
    archive,
    reportTtlMs: 0,
  });
  baseUrl = started.url;
  stop = started.close;
});

afterAll(async () => {
  if (stop) await stop();
  rmSync(logRoot, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

describe('history outliving the logs', () => {
  it('reports both projects while the logs are there', async () => {
    const body = await get('/api/report?range=all');
    expect(body.projects.map((p: any) => p.name).sort()).toEqual(['alpha', 'beta']);
    expect(body.totals.totalMs).toBe(90 * MIN);
    expect(body.scan.daysRestored).toBe(0);
  });

  it('still reports them after Claude Code deletes the transcripts', async () => {
    rmSync(join(logRoot, 'proj-alpha'), { recursive: true, force: true });
    rmSync(join(logRoot, 'proj-beta'), { recursive: true, force: true });
    invalidateReportCache();

    const body = await get('/api/report?range=all&refresh=1');

    expect(body.scan.filesScanned).toBe(0);
    expect(body.scan.daysRestored).toBe(2);
    expect(body.projects.map((p: any) => p.name).sort()).toEqual(['alpha', 'beta']);
    expect(body.totals.totalMs).toBe(90 * MIN);
  });

  it('keeps the restored days addressable by date, not just in the grand total', async () => {
    const body = await get('/api/report?range=all&refresh=1');
    const alpha = body.projects.find((p: any) => p.name === 'alpha');

    expect(alpha.activeDays).toBe(1);
    expect(Object.values(alpha.byDay)).toEqual([HOUR]);
    expect(body.days).toHaveLength(2);
  });

  it('carries the tags a restored project was given while its logs existed', async () => {
    // The archive keys on the resolved project path, which is also the tag key,
    // so a project's client and aliases must outlive its transcripts too.
    const alphaPath = 'C:\\work\\alpha';
    const res = await fetch(`${baseUrl}/api/project-meta`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: alphaPath, patch: { client: 'Acme', alias: 'Alpha Rebuild' } }),
    });
    expect(res.status).toBe(200);

    const body = await get('/api/report?range=all&refresh=1');
    const alpha = body.projects.find((p: any) => p.id === alphaPath);
    expect(alpha.displayName).toBe('Alpha Rebuild');
    expect(alpha.client).toBe('Acme');
  });

  it('leaves a narrower range unaffected by history outside it', async () => {
    const body = await get('/api/report?range=today&refresh=1');
    expect(body.projects).toHaveLength(0);
    expect(body.totals.totalMs).toBe(0);
  });
});
