import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TagStore } from '../../src/core/tag-store.js';
import { TimelineCache } from '../../src/core/timeline-cache.js';
import { TokenCache } from '../../src/core/token-cache.js';
import { startDashboardServer } from '../../src/server/server.js';
import { invalidateReportCache } from '../../src/server/api.js';

/**
 * The tokens endpoint end to end through the HTTP server.
 *
 * The point of exercise here is that cost and hours are two views of the same
 * projects: whatever client a project is assigned in one must govern the other,
 * because a project that bills to two different clients depending on the tab is
 * worse than no answer at all.
 */

const DAY = 24 * 60 * 60_000;

let logRoot: string;
let dataDir: string;
let baseUrl: string;
let stop: () => Promise<void>;

function midnight(daysAgo: number): number {
  const d = new Date();
  d.setHours(10, 0, 0, 0);
  return d.getTime() - daysAgo * DAY;
}

function writeSession(
  dirName: string,
  sessionId: string,
  cwd: string,
  turns: Array<{ at: number; model: string; input?: number; output?: number; cacheRead?: number }>,
): void {
  const dir = join(logRoot, dirName);
  mkdirSync(dir, { recursive: true });

  // Each turn is written the way Claude Code writes one: the prompt, the
  // assistant reply carrying usage, and the recorded duration. Tokens come from
  // the middle line and hours from the last, so one fixture feeds both views —
  // which is the only way to check that they agree on project identity.
  const lines: string[] = [];
  for (const t of turns) {
    lines.push(JSON.stringify({
      type: 'user', origin: { kind: 'human' }, message: { content: 'go' },
      cwd, sessionId, timestamp: new Date(t.at).toISOString(),
    }));
    lines.push(JSON.stringify({
      type: 'assistant',
      cwd,
      sessionId,
      timestamp: new Date(t.at + 60_000).toISOString(),
      message: {
        model: t.model,
        usage: {
          input_tokens: t.input ?? 0,
          output_tokens: t.output ?? 0,
          cache_read_input_tokens: t.cacheRead ?? 0,
        },
      },
    }));
    lines.push(JSON.stringify({
      type: 'system', subtype: 'turn_duration', durationMs: 60_000,
      cwd, sessionId, timestamp: new Date(t.at + 60_000).toISOString(),
    }));
  }

  writeFileSync(join(dir, `${sessionId}.jsonl`), lines.join('\n') + '\n', 'utf-8');
}

async function get(path: string): Promise<any> {
  const res = await fetch(`${baseUrl}${path}`);
  return JSON.parse(await res.text());
}

async function post(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return JSON.parse(await res.text());
}

beforeAll(async () => {
  logRoot = mkdtempSync(join(tmpdir(), 'meter-tok-logs-'));
  dataDir = mkdtempSync(join(tmpdir(), 'meter-tok-data-'));

  writeSession('J--work-alpha', 'alpha-1', 'J:\\work\\alpha', [
    { at: midnight(2), model: 'claude-opus-5', input: 1000, output: 2000, cacheRead: 500_000 },
    { at: midnight(1), model: 'claude-opus-5', input: 500, output: 1000 },
  ]);
  writeSession('J--work-beta', 'beta-1', 'J:\\work\\beta', [
    { at: midnight(1), model: 'claude-sonnet-5', input: 100, output: 200 },
  ]);

  const tags = new TagStore(dataDir).load();
  const cache = new TimelineCache(dataDir);
  cache.load();
  const tokenCache = new TokenCache(dataDir);
  tokenCache.load();

  invalidateReportCache();

  const started = await startDashboardServer({
    port: 0,
    host: '127.0.0.1',
    logPaths: [logRoot],
    tags,
    cache,
    tokenCache,
    reportTtlMs: 0,
  });

  baseUrl = started.url;
  stop = started.close;
});

afterAll(async () => {
  await stop();
  rmSync(logRoot, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

describe('GET /api/tokens', () => {
  it('reports both projects with cost and token totals', async () => {
    const body = await get('/api/tokens?range=all');

    expect(body.projects).toHaveLength(2);
    expect(body.totals.fresh).toBe(4800);
    expect(body.totals.cacheRead).toBe(500_000);
    expect(body.totals.costUsd).toBeGreaterThan(0);
    expect(body.rangeLabel).toBe('all');
  });

  it('names the project by its resolved path, not the log folder slug', async () => {
    const body = await get('/api/tokens?range=all');
    const names = body.projects.map((p: any) => p.name).sort();
    expect(names).toEqual(['alpha', 'beta']);
  });

  it('breaks usage down by day', async () => {
    const body = await get('/api/tokens?range=all');
    const alpha = body.projects.find((p: any) => p.name === 'alpha');

    expect(Object.keys(alpha.byDay)).toHaveLength(2);
    expect(alpha.activeDays).toBe(2);
    expect(body.days).toHaveLength(2);
    expect(body.days[0].day < body.days[1].day).toBe(true);
  });

  it('narrows to the requested range', async () => {
    const body = await get('/api/tokens?range=today');
    expect(body.totals.fresh).toBe(0);
    expect(body.projects).toHaveLength(0);
  });

  it('reports the pricing table it used', async () => {
    const body = await get('/api/tokens?range=all');
    expect(body.pricing.source).toBe('bundled');
    expect(body.pricing.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.pricing.guessedModels).toEqual([]);
  });

  // The whole reason both views resolve projects the same way: one assignment,
  // both tabs. A project billing to two different clients depending on which
  // tab you are looking at would be worse than no answer.
  it('carries the same client assignment the hours view uses', async () => {
    await post('/api/project-meta', {
      path: 'J:\\work\\alpha',
      patch: { client: 'Acme', tags: ['retainer'], alias: 'Alpha Platform' },
    });
    invalidateReportCache();

    const tokens = await get('/api/tokens?range=all');
    const hours = await get('/api/report?range=all');

    const tokenAlpha = tokens.projects.find((p: any) => p.name === 'alpha');
    const hoursAlpha = hours.projects.find((p: any) => p.name === 'alpha');

    expect(tokenAlpha.client).toBe('Acme');
    expect(tokenAlpha.displayName).toBe('Alpha Platform');
    expect(tokenAlpha.tags).toEqual(['retainer']);
    // Same identity on both sides, which is what makes one assignment enough.
    expect(tokenAlpha.id).toBe(hoursAlpha.id);
    expect(tokens.clients).toEqual(hours.clients);
  });

  it('serves the second request from the token cache', async () => {
    invalidateReportCache();
    const first = await get('/api/tokens?range=all');
    invalidateReportCache();
    const second = await get('/api/tokens?range=all');

    expect(second.scan.filesFromCache).toBe(first.scan.filesScanned);
    expect(second.totals.costUsd).toBeCloseTo(first.totals.costUsd, 8);
  });
});
