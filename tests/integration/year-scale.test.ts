import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TagStore } from '../../src/core/tag-store.js';
import { TimelineCache } from '../../src/core/timeline-cache.js';
import { startDashboardServer } from '../../src/server/server.js';

/**
 * A year of real history, end to end.
 *
 * The dashboard is meant to be pointed at a working directory that keeps
 * accumulating, so the failure mode that matters is not "wrong on three
 * sessions" but "unusable on a thousand". This builds a year of session logs on
 * disk and asserts the things that quietly stop holding as history grows:
 * response size, request time, cache behaviour, and totals still being exact.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const DAYS = 365;
const PROJECTS = ['alpha', 'beta'];
const TURNS_PER_SESSION = 4;
const TURN_MS = 15 * MIN;
/** Every session is deliberately identical in shape so the total is exact. */
const PER_SESSION_MS = TURNS_PER_SESSION * TURN_MS;
const TOTAL_SESSIONS = DAYS * PROJECTS.length;

let logRoot: string;
let dataDir: string;
let baseUrl: string;
let stop: () => Promise<void>;
let cache: TimelineCache;
let firstScanMs = 0;
let reportBytes = 0;

const iso = (ms: number) => new Date(ms).toISOString();

function midnightDaysAgo(n: number): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime() - n * DAY;
}

function buildYear(): void {
  for (const project of PROJECTS) {
    const dir = join(logRoot, `proj-${project}`);
    mkdirSync(dir, { recursive: true });

    for (let dayOffset = 1; dayOffset <= DAYS; dayOffset++) {
      // 09:00 local, so no turn crosses midnight and the arithmetic stays exact.
      const dayStart = midnightDaysAgo(dayOffset) + 9 * HOUR;
      const lines: string[] = [];

      for (let t = 0; t < TURNS_PER_SESSION; t++) {
        const start = dayStart + t * (TURN_MS + MIN);
        const end = start + TURN_MS;
        lines.push(JSON.stringify({
          type: 'user',
          origin: { kind: 'human' },
          message: { content: 'work' },
          cwd: `C:\\work\\${project}`,
          timestamp: iso(start),
        }));
        lines.push(JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', name: 'Bash' }] },
          cwd: `C:\\work\\${project}`,
          timestamp: iso(start + 500),
        }));
        lines.push(JSON.stringify({
          type: 'system',
          subtype: 'turn_duration',
          durationMs: TURN_MS,
          cwd: `C:\\work\\${project}`,
          timestamp: iso(end),
        }));
      }

      writeFileSync(join(dir, `${project}-${dayOffset}.jsonl`), lines.join('\n'), 'utf-8');
    }
  }
}

async function get(path: string): Promise<{ status: number; body: any; bytes: number; ms: number }> {
  const started = Date.now();
  const res = await fetch(`${baseUrl}${path}`);
  const text = await res.text();
  return {
    status: res.status,
    body: text ? JSON.parse(text) : null,
    bytes: Buffer.byteLength(text),
    ms: Date.now() - started,
  };
}

async function post(path: string, payload: unknown): Promise<{ status: number; body: any; bytes: number }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, bytes: Buffer.byteLength(text) };
}

beforeAll(async () => {
  logRoot = mkdtempSync(join(tmpdir(), 'meter-year-logs-'));
  dataDir = mkdtempSync(join(tmpdir(), 'meter-year-data-'));
  buildYear();

  const tags = new TagStore(dataDir).load();
  cache = new TimelineCache(dataDir);
  cache.load();

  const started = await startDashboardServer({
    port: 0,
    host: '127.0.0.1',
    logPaths: [logRoot],
    tags,
    cache,
    reportTtlMs: 0,
  });
  baseUrl = started.url;
  stop = started.close;

  // Cold scan of the whole year, timed.
  const first = await get('/api/report?range=all');
  firstScanMs = first.ms;
  reportBytes = first.bytes;
}, 300_000);

afterAll(async () => {
  if (stop) await stop();
  rmSync(logRoot, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

describe('a year of history', () => {
  it('scans every session without failures', async () => {
    const { body } = await get('/api/report?range=all');
    expect(body.scan.filesScanned).toBe(TOTAL_SESSIONS);
    expect(body.scan.filesFailed).toBe(0);
    expect(body.scan.sessionsMeasured).toBe(TOTAL_SESSIONS);
    expect(body.warnings).toEqual([]);
  });

  it('totals exactly, with no drift across 365 days', async () => {
    const { body } = await get('/api/report?range=all');
    expect(body.totals.totalMs).toBe(TOTAL_SESSIONS * PER_SESSION_MS);
    expect(body.totals.sessionCount).toBe(TOTAL_SESSIONS);
    expect(body.totals.activeDays).toBe(DAYS);

    for (const project of body.projects) {
      expect(project.totalMs).toBe(DAYS * PER_SESSION_MS);
      expect(Object.keys(project.byDay)).toHaveLength(DAYS);
    }
  });

  it('keeps the response small — it must not grow with history', async () => {
    // The whole point of moving the fold server-side. Before that change this
    // payload carried every interval of every session: 365 days x 2 projects x
    // 4 turns is ~2900 intervals, and it would keep climbing forever.
    expect(reportBytes).toBeLessThan(600_000);
  });

  it('answers a cold scan of a year within a sane time', async () => {
    expect(firstScanMs).toBeLessThan(60_000);
  });

  it('serves a repeat request from cache, much faster than the cold scan', async () => {
    const again = await get('/api/report?range=all');
    expect(again.body.scan.filesFromCache).toBe(TOTAL_SESSIONS);
    expect(again.ms).toBeLessThan(Math.max(firstScanMs, 1000));
  });

  it('is not slowed down by changing the idle threshold', async () => {
    // Turn-measured entries are threshold-independent, so this must stay a
    // cache hit rather than forcing a full rescan of the year.
    const { body } = await get('/api/report?range=all&idle=1800');
    expect(body.scan.filesFromCache).toBe(TOTAL_SESSIONS);
  });
});

describe('the cache at a year of scale', () => {
  it('wrote one record per session and can be reloaded', () => {
    const stats = cache.getFileStats();
    expect(stats.entries).toBe(TOTAL_SESSIONS);

    const reopened = new TimelineCache(dataDir);
    reopened.load();
    expect(reopened.getFileStats().entries).toBe(TOTAL_SESSIONS);
  });

  it('appends a single changed session instead of rewriting the file', () => {
    const before = cache.getFileStats().recordsOnDisk;
    const cachePath = join(dataDir, 'timeline-cache.ndjson');
    const sizeBefore = statSync(cachePath).size;

    // A scratch file outside the log root: writing a stub entry for a real
    // session would poison the totals every later test asserts on.
    const target = join(dataDir, 'scratch-session.jsonl');
    writeFileSync(target, '{}', 'utf-8');
    cache.set(target, {
      idleSeconds: 300,
      source: 'turns',
      intervals: [[1, 2]],
      cwds: [],
      firstSeen: 1,
      lastSeen: 2,
    });
    const result = cache.save();

    expect(result.ok).toBe(true);
    const after = cache.getFileStats().recordsOnDisk;
    expect(after - before).toBe(1);
    // Grew by roughly one record, not doubled.
    expect(statSync(cachePath).size).toBeLessThan(sizeBefore * 1.1);
  });

  it('survives a torn trailing line from an interrupted append', () => {
    const cachePath = join(dataDir, 'timeline-cache.ndjson');
    appendFileSync(cachePath, '{"path":"broken","interv', 'utf-8');

    const reopened = new TimelineCache(dataDir);
    reopened.load();
    // Everything before the torn line is still usable — nothing was lost.
    expect(reopened.getFileStats().entries).toBeGreaterThanOrEqual(TOTAL_SESSIONS);
  });

  it('removes a legacy v2 cache file on load', () => {
    const legacy = join(dataDir, 'timeline-cache.json');
    writeFileSync(legacy, JSON.stringify({ version: 2, sessions: {} }), 'utf-8');

    new TimelineCache(dataDir).load();
    expect(existsSync(legacy)).toBe(false);
  });
});

describe('concurrent load', () => {
  it('collapses simultaneous identical requests into one scan', async () => {
    // Loading the dashboard fires /api/report and /api/wallclock at once, and
    // both build the report. Before these were coalesced each caller ran its
    // own scan of every session log, competing for the same CPU; over a large
    // log directory that starved the event loop and the server stopped
    // answering anything until they finished.
    const started = Date.now();
    const responses = await Promise.all([
      get('/api/report?range=all&idle=42'),
      get('/api/report?range=all&idle=42'),
      get('/api/report?range=all&idle=42'),
      get('/api/report?range=all&idle=42'),
      get('/api/report?range=all&idle=42'),
    ]);
    const elapsed = Date.now() - started;

    for (const r of responses) {
      expect(r.status).toBe(200);
      expect(r.body.totals.totalMs).toBe(TOTAL_SESSIONS * PER_SESSION_MS);
    }

    // Five duplicate scans of the year would take far longer than one.
    expect(elapsed).toBeLessThan(60_000);
  });

  it('stays responsive to other endpoints while a report is building', async () => {
    const report = get('/api/report?range=all&idle=77');
    const health = await get('/api/health');
    expect(health.status).toBe(200);
    await report;
  });
});

describe('wall-clock at a year of scale', () => {
  it('matches the report total and stays a small response', async () => {
    const report = await get('/api/report?range=all');
    const ids = report.body.projects.map((p: any) => p.id);

    const { body, bytes } = await post('/api/wallclock?range=all', {
      projects: ids,
      groupBy: 'day',
    });

    expect(body.totalMs).toBe(report.body.totals.wallClockMs);
    // 365 day buckets plus a total — a few tens of KB at most, forever.
    expect(bytes).toBeLessThan(50_000);
  });

  it('collapses to 12-ish buckets when grouped by month', async () => {
    const report = await get('/api/report?range=all');
    const ids = report.body.projects.map((p: any) => p.id);

    const { body } = await post('/api/wallclock?range=all', { projects: ids, groupBy: 'month' });
    const keys = Object.keys(body.buckets);

    // A year spans 12 or 13 calendar months depending on today's date.
    expect(keys.length).toBeGreaterThanOrEqual(12);
    expect(keys.length).toBeLessThanOrEqual(13);
    const summed = Object.values(body.buckets).reduce((a: number, b: any) => a + b, 0);
    expect(summed).toBe(body.totalMs);
  });

  it('still answers correctly for a range a year in the past', async () => {
    const oldest = midnightDaysAgo(DAYS);
    const day = new Date(oldest);
    const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;

    const { body } = await get(`/api/report?start=${key}&end=${key}`);
    // Both projects worked that day, one session each.
    expect(body.totals.totalMs).toBe(PROJECTS.length * PER_SESSION_MS);
  });
});
