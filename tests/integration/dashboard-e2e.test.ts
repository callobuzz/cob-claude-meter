import { mkdtempSync, mkdirSync, rmSync, writeFileSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TagStore } from '../../src/core/tag-store.js';
import { TimelineCache } from '../../src/core/timeline-cache.js';
import { startDashboardServer } from '../../src/server/server.js';

/**
 * End-to-end against the real thing.
 *
 * Real session logs written to a real directory, read by the real scanner,
 * served by the real HTTP server, fetched over a real socket. Nothing here is
 * stubbed: the only concession to the test environment is that the log
 * directory and data directory are temporary rather than the developer's own.
 *
 * The point is to catch what unit tests structurally cannot — that the pieces
 * agree with each other, and that they still agree once a year of history has
 * accumulated.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

let logRoot: string;
let dataDir: string;
let baseUrl: string;
let stop: () => Promise<void>;

/** Local midnight, so assertions line up with the local-time day bucketing. */
function localMidnight(daysAgo: number): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime() - daysAgo * DAY;
}

const iso = (ms: number) => new Date(ms).toISOString();

interface TurnSpec {
  /** When the turn started. */
  start: number;
  /** How long the agent worked. */
  durationMs: number;
}

/**
 * Writes a session log the way Claude Code does: a human prompt, some assistant
 * and tool traffic, then the turn_duration record that closes the turn.
 */
function writeSession(projectDir: string, sessionId: string, cwd: string, turns: TurnSpec[]): void {
  mkdirSync(projectDir, { recursive: true });
  const lines: string[] = [];

  for (const turn of turns) {
    const end = turn.start + turn.durationMs;
    lines.push(JSON.stringify({
      type: 'user',
      origin: { kind: 'human' },
      message: { content: 'do the thing' },
      cwd,
      timestamp: iso(turn.start),
    }));
    lines.push(JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash' }] },
      cwd,
      timestamp: iso(turn.start + Math.min(1000, turn.durationMs / 2)),
    }));
    // The tool result lands whenever the tool finished — possibly much later.
    lines.push(JSON.stringify({
      type: 'user',
      toolUseResult: { stdout: 'ok', stderr: '', interrupted: false },
      message: { content: [{ type: 'tool_result' }] },
      cwd,
      timestamp: iso(end - 1),
    }));
    lines.push(JSON.stringify({
      type: 'system',
      subtype: 'turn_duration',
      durationMs: turn.durationMs,
      cwd,
      timestamp: iso(end),
    }));
  }

  writeFileSync(join(projectDir, `${sessionId}.jsonl`), lines.join('\n'), 'utf-8');
}

async function get(path: string): Promise<{ status: number; body: any; bytes: number }> {
  const res = await fetch(`${baseUrl}${path}`);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, bytes: Buffer.byteLength(text) };
}

async function post(path: string, payload: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

beforeAll(async () => {
  logRoot = mkdtempSync(join(tmpdir(), 'meter-e2e-logs-'));
  dataDir = mkdtempSync(join(tmpdir(), 'meter-e2e-data-'));

  // --- alpha: two sessions running the SAME hour, so summed != wall-clock ---
  const alphaDay = localMidnight(1) + 9 * HOUR;
  writeSession(join(logRoot, 'proj-alpha'), 'alpha-1', 'C:\\work\\alpha', [
    { start: alphaDay, durationMs: HOUR },
  ]);
  writeSession(join(logRoot, 'proj-alpha'), 'alpha-2', 'C:\\work\\alpha', [
    { start: alphaDay, durationMs: HOUR },
  ]);

  // --- beta: one turn that spent 40 minutes inside a single tool call ---
  writeSession(join(logRoot, 'proj-beta'), 'beta-1', 'C:\\work\\beta', [
    { start: localMidnight(1) + 14 * HOUR, durationMs: 40 * MIN },
  ]);

  // --- gamma: a turn crossing local midnight, 30 min either side ---
  writeSession(join(logRoot, 'proj-gamma'), 'gamma-1', 'C:\\work\\gamma', [
    { start: localMidnight(2) - 30 * MIN, durationMs: HOUR },
  ]);

  const tags = new TagStore(dataDir).load();
  const cache = new TimelineCache(dataDir);
  cache.load();

  const started = await startDashboardServer({
    port: 0, // let the OS pick a free port
    host: '127.0.0.1',
    logPaths: [logRoot],
    tags,
    cache,
    reportTtlMs: 0, // never serve a memoised report; each request recomputes
  });
  baseUrl = started.url;
  stop = started.close;
});

afterAll(async () => {
  if (stop) await stop();
  rmSync(logRoot, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

describe('server', () => {
  it('serves health with the configured log path', async () => {
    const { status, body } = await get('/api/health');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.logPaths).toContain(logRoot);
  });

  it('serves the dashboard HTML', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('refuses to serve files outside the public directory', async () => {
    const res = await fetch(`${baseUrl}/../../package.json`);
    expect([403, 404]).toContain(res.status);
  });
});

describe('report', () => {
  it('finds every project and resolves its real path', async () => {
    const { body } = await get('/api/report?range=all');
    const names = body.projects.map((p: any) => p.name).sort();
    expect(names).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('counts a 40-minute tool call in full', async () => {
    const { body } = await get('/api/report?range=all');
    const beta = body.projects.find((p: any) => p.name === 'beta');
    expect(beta.totalMs).toBe(40 * MIN);
  });

  it('is unaffected by the idle threshold when turn records exist', async () => {
    // A 30s cutoff would obliterate a gap-inferred 40-minute tool call.
    const tight = await get('/api/report?range=all&idle=30');
    const loose = await get('/api/report?range=all&idle=3600');
    const betaTight = tight.body.projects.find((p: any) => p.name === 'beta');
    const betaLoose = loose.body.projects.find((p: any) => p.name === 'beta');
    expect(betaTight.totalMs).toBe(40 * MIN);
    expect(betaLoose.totalMs).toBe(40 * MIN);
  });

  it('sums concurrent sessions but folds them into one wall-clock hour', async () => {
    const { body } = await get('/api/report?range=all');
    const alpha = body.projects.find((p: any) => p.name === 'alpha');
    expect(alpha.sessionCount).toBe(2);
    expect(alpha.totalMs).toBe(2 * HOUR);      // two terminals, two hours billed
    expect(alpha.wallClockMs).toBe(HOUR);      // but only one hour elapsed
  });

  it('splits a midnight-crossing turn across both days', async () => {
    const { body } = await get('/api/report?range=all');
    const gamma = body.projects.find((p: any) => p.name === 'gamma');
    const days = Object.keys(gamma.byDay).sort();
    expect(days).toHaveLength(2);
    expect(gamma.byDay[days[0]]).toBe(30 * MIN);
    expect(gamma.byDay[days[1]]).toBe(30 * MIN);
    expect(gamma.totalMs).toBe(HOUR);
  });

  it('reports every session as measured, none inferred', async () => {
    const { body } = await get('/api/report?range=all');
    expect(body.scan.sessionsMeasured).toBe(4);
    expect(body.scan.sessionsInferred).toBe(0);
    expect(body.scan.filesFailed).toBe(0);
    expect(body.warnings).toEqual([]);
  });

  it('does not ship raw intervals to the client', async () => {
    const { body } = await get('/api/report?range=all');
    for (const project of body.projects) {
      expect(project.intervals).toBeUndefined();
    }
  });
});

describe('wall-clock endpoint', () => {
  it('folds concurrent sessions into a single hour', async () => {
    const report = await get('/api/report?range=all');
    const alpha = report.body.projects.find((p: any) => p.name === 'alpha');

    const { status, body } = await post('/api/wallclock?range=all', {
      projects: [alpha.id],
      groupBy: 'day',
    });

    expect(status).toBe(200);
    expect(body.totalMs).toBe(HOUR);
  });

  it('matches the report total when every project is selected', async () => {
    const report = await get('/api/report?range=all');
    const ids = report.body.projects.map((p: any) => p.id);

    const { body } = await post('/api/wallclock?range=all', { projects: ids, groupBy: 'day' });
    expect(body.totalMs).toBe(report.body.totals.wallClockMs);
  });

  it('returns zero for an empty selection rather than everything', async () => {
    const { body } = await post('/api/wallclock?range=all', { projects: [], groupBy: 'day' });
    expect(body.totalMs).toBe(0);
    expect(Object.keys(body.buckets)).toHaveLength(0);
  });

  it('buckets sum to the total', async () => {
    const report = await get('/api/report?range=all');
    const ids = report.body.projects.map((p: any) => p.id);
    const { body } = await post('/api/wallclock?range=all', { projects: ids, groupBy: 'day' });

    const summed = Object.values(body.buckets).reduce((a: number, b: any) => a + b, 0);
    expect(summed).toBe(body.totalMs);
  });

  it('gives the same total whether grouped by day, week or month', async () => {
    const report = await get('/api/report?range=all');
    const ids = report.body.projects.map((p: any) => p.id);

    const byDay = await post('/api/wallclock?range=all', { projects: ids, groupBy: 'day' });
    const byWeek = await post('/api/wallclock?range=all', { projects: ids, groupBy: 'week' });
    const byMonth = await post('/api/wallclock?range=all', { projects: ids, groupBy: 'month' });

    expect(byWeek.body.totalMs).toBe(byDay.body.totalMs);
    expect(byMonth.body.totalMs).toBe(byDay.body.totalMs);
  });

  it('splits a midnight-crossing turn across two day buckets', async () => {
    const report = await get('/api/report?range=all');
    const gamma = report.body.projects.find((p: any) => p.name === 'gamma');

    const { body } = await post('/api/wallclock?range=all', {
      projects: [gamma.id],
      groupBy: 'day',
    });

    const keys = Object.keys(body.buckets).sort();
    expect(keys).toHaveLength(2);
    expect(body.buckets[keys[0]]).toBe(30 * MIN);
    expect(body.buckets[keys[1]]).toBe(30 * MIN);
  });
});

describe('project metadata round-trip', () => {
  it('persists a client tag and returns it on the next report', async () => {
    const before = await get('/api/report?range=all');
    const beta = before.body.projects.find((p: any) => p.name === 'beta');

    const saved = await post('/api/project-meta', {
      path: beta.id,
      patch: { client: 'Acme', tags: ['billable'], alias: 'Beta Rework' },
    });
    expect(saved.status).toBe(200);

    const after = await get('/api/report?range=all');
    const updated = after.body.projects.find((p: any) => p.id === beta.id);
    expect(updated.client).toBe('Acme');
    expect(updated.tags).toContain('billable');
    expect(updated.displayName).toBe('Beta Rework');
    expect(after.body.clients).toContain('Acme');
  });
});
