import { DateRangeLabel, getDateRange } from '../core/date-ranges.js';
import { ProjectTime, TimeReport, buildTimeReport } from '../core/time-aggregator.js';
import { TimelineCache } from '../core/timeline-cache.js';
import { DayArchive } from '../core/day-archive.js';
import { ProjectMeta, TagStore } from '../core/tag-store.js';
import { DEFAULT_IDLE_SECONDS } from '../core/time-tracker.js';
import { ProjectTokens, TokenReport, buildTokenReport } from '../core/token-aggregator.js';
import { TokenCache } from '../core/token-cache.js';
import { TokenArchive } from '../core/token-archive.js';
import { GroupBy, WallClockRequest, computeWallClock } from '../core/wall-clock.js';

export interface ApiContext {
  logPaths: string[];
  tags: TagStore;
  cache: TimelineCache;
  /** Durable history. Optional: without it the dashboard sees only live logs. */
  archive?: DayArchive;
  /** Token breakdowns. Optional: without it every tokens request rescans. */
  tokenCache?: TokenCache;
  /** Durable token history. Optional: without it spend dies with the logs. */
  tokenArchive?: TokenArchive;
  /** Reports are memoised for this long so rapid filter changes do not rescan. */
  reportTtlMs: number;
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

/**
 * A project as sent to the browser.
 *
 * `intervals` is deliberately absent. The raw intervals are the one part of a
 * report that grows without bound — a year of sessions is megabytes of
 * timestamps — and the only thing the client used them for was folding a
 * filtered subset into a wall-clock union. That fold now happens server-side
 * via /api/wallclock, so the response carries numbers rather than history.
 */
export interface DecoratedProject extends Omit<ProjectTime, 'intervals'> {
  displayName: string;
  client: string | null;
  tags: string[];
  hidden: boolean;
}

export interface ReportResponse extends Omit<TimeReport, 'projects'> {
  rangeLabel: string;
  projects: DecoratedProject[];
  clients: string[];
  allTags: string[];
}

/**
 * A project's token usage, carrying the same client and tag metadata the hours
 * view uses. Both sides resolve to the same project path, so one assignment
 * covers both and the two tabs can never disagree on who a project belongs to.
 */
export interface DecoratedTokenProject extends ProjectTokens {
  displayName: string;
  client: string | null;
  tags: string[];
  hidden: boolean;
}

export interface TokenResponse extends Omit<TokenReport, 'projects'> {
  rangeLabel: string;
  projects: DecoratedTokenProject[];
  clients: string[];
  allTags: string[];
}

const VALID_RANGES: DateRangeLabel[] = [
  'today', 'yesterday', 'this-week', 'last-week',
  'this-month', 'last-month', 'this-year', 'last30', 'all',
];

interface CachedReport {
  key: string;
  builtAt: number;
  report: TimeReport;
}

let memo: CachedReport | null = null;

/**
 * Builds currently running, keyed the same way the memo is.
 *
 * The memo only exists once a build has finished, so without this every
 * concurrent request for the same report starts its own scan. That is the
 * normal case, not an edge one: loading the dashboard fires /api/report and
 * /api/wallclock together, and both need the report. On a cold cache over a
 * large log directory those duplicate scans compete for the same CPU and
 * saturate the event loop, which makes the server stop answering anything at
 * all until they finish. Sharing the in-flight promise means N callers cost
 * one scan.
 */
const inFlight = new Map<string, Promise<TimeReport>>();

interface CachedTokenReport {
  key: string;
  builtAt: number;
  report: TokenReport;
}

/**
 * Tokens are memoised separately from hours.
 *
 * They share neither a key nor a build: the token report ignores the idle
 * threshold entirely, so folding it into the hours memo would throw away a
 * perfectly valid result every time the viewer nudged that dropdown.
 */
let tokenMemo: CachedTokenReport | null = null;
const tokensInFlight = new Map<string, Promise<TokenReport>>();

/** Drops the in-memory report caches. Exported for tests and for forced refreshes. */
export function invalidateReportCache(): void {
  memo = null;
  inFlight.clear();
  tokenMemo = null;
  tokensInFlight.clear();
}

function resolveRange(params: URLSearchParams): { start: number; end: number; label: string } {
  const startParam = params.get('start');
  const endParam = params.get('end');

  if (startParam && endParam) {
    const start = new Date(startParam).getTime();
    // An end date alone means midnight; include the whole day the user picked.
    const endDate = new Date(endParam);
    const end = /T/.test(endParam)
      ? endDate.getTime()
      : new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate() + 1).getTime() - 1;

    if (!isNaN(start) && !isNaN(end)) {
      return { start, end, label: `${startParam} → ${endParam}` };
    }
  }

  const rangeParam = (params.get('range') ?? 'this-month') as DateRangeLabel;
  const label = VALID_RANGES.includes(rangeParam) ? rangeParam : 'this-month';
  const range = getDateRange(label, new Date());
  return { start: range.start.getTime(), end: range.end.getTime(), label };
}

function decorate(project: ProjectTime, meta: ProjectMeta): DecoratedProject {
  const { intervals: _intervals, ...rest } = project;
  return {
    ...rest,
    displayName: meta.alias ?? project.name,
    client: meta.client,
    tags: meta.tags,
    hidden: meta.hidden,
  };
}

async function getReport(
  ctx: ApiContext,
  start: number,
  end: number,
  idleSeconds: number,
  force: boolean,
): Promise<TimeReport> {
  const key = `${start}|${end}|${idleSeconds}`;

  if (!force && memo && memo.key === key && Date.now() - memo.builtAt < ctx.reportTtlMs) {
    return memo.report;
  }

  // Join a build already under way rather than starting a second one. A forced
  // refresh still waits on it: the scan it would duplicate is reading the same
  // files it would read itself, and one is enough.
  const running = inFlight.get(key);
  if (running) return running;

  const build = buildTimeReport({
    logPaths: ctx.logPaths,
    idleSeconds,
    start,
    end,
    cache: ctx.cache,
    archive: ctx.archive,
  })
    .then(report => {
      memo = { key, builtAt: Date.now(), report };
      return report;
    })
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, build);
  return build;
}

async function getTokenReport(
  ctx: ApiContext,
  start: number,
  end: number,
  force: boolean,
): Promise<TokenReport> {
  const key = `${start}|${end}`;

  if (!force && tokenMemo && tokenMemo.key === key && Date.now() - tokenMemo.builtAt < ctx.reportTtlMs) {
    return tokenMemo.report;
  }

  // Join a build already under way rather than starting a second one — the
  // first load of a cold cache walks every log file, and two of those at once
  // saturate the event loop and stall the whole server.
  const running = tokensInFlight.get(key);
  if (running) return running;

  const build = buildTokenReport({
    logPaths: ctx.logPaths,
    start,
    end,
    cache: ctx.tokenCache,
    archive: ctx.tokenArchive,
  })
    .then(report => {
      tokenMemo = { key, builtAt: Date.now(), report };
      return report;
    })
    .finally(() => {
      tokensInFlight.delete(key);
    });

  tokensInFlight.set(key, build);
  return build;
}

/**
 * Routes one API request.
 *
 * Kept free of node:http so the whole surface can be exercised in tests
 * without binding a port.
 */
export async function handleApiRequest(
  method: string,
  pathname: string,
  params: URLSearchParams,
  body: unknown,
  ctx: ApiContext,
): Promise<ApiResponse> {
  if (method === 'GET' && pathname === '/api/health') {
    return { status: 200, body: { ok: true, logPaths: ctx.logPaths } };
  }

  if (method === 'POST' && pathname === '/api/wallclock') {
    const { start, end } = resolveRange(params);
    const idleSeconds = clampIdle(params.get('idle'));
    const report = await getReport(ctx, start, end, idleSeconds, false);

    const payload = (body ?? {}) as Partial<WallClockRequest>;
    const groupBy: GroupBy =
      payload.groupBy === 'week' || payload.groupBy === 'month' ? payload.groupBy : 'day';
    // An absent list means every project; an empty one means none. The
    // difference matters — filtering everything out must read as zero, not all.
    const projects = Array.isArray(payload.projects)
      ? payload.projects.filter((p): p is string => typeof p === 'string')
      : report.projects.map(p => p.id);

    const byProject = new Map(report.projects.map(p => [p.id, p.intervals]));
    return { status: 200, body: computeWallClock(byProject, { projects, groupBy }) };
  }

  if (method === 'GET' && pathname === '/api/report') {
    const { start, end, label } = resolveRange(params);
    const idleSeconds = clampIdle(params.get('idle'));
    const force = params.get('refresh') === '1';

    const report = await getReport(ctx, start, end, idleSeconds, force);

    const projects = report.projects.map(p => decorate(p, ctx.tags.get(p.id)));

    const response: ReportResponse = {
      ...report,
      rangeLabel: label,
      projects,
      clients: ctx.tags.listClients(),
      allTags: ctx.tags.listTags(),
    };

    return { status: 200, body: response };
  }

  if (method === 'GET' && pathname === '/api/tokens') {
    const { start, end, label } = resolveRange(params);
    const force = params.get('refresh') === '1';

    const report = await getTokenReport(ctx, start, end, force);

    const projects = report.projects.map(p => {
      const meta = ctx.tags.get(p.id);
      return {
        ...p,
        displayName: meta.alias ?? p.name,
        client: meta.client,
        tags: meta.tags,
        hidden: meta.hidden,
      };
    });

    const response: TokenResponse = {
      ...report,
      rangeLabel: label,
      projects,
      clients: ctx.tags.listClients(),
      allTags: ctx.tags.listTags(),
    };

    return { status: 200, body: response };
  }

  if (method === 'POST' && pathname === '/api/project-meta') {
    const payload = body as { path?: string; patch?: Partial<ProjectMeta> };
    if (!payload || typeof payload.path !== 'string' || !payload.path) {
      return { status: 400, body: { error: 'path is required' } };
    }
    if (!payload.patch || typeof payload.patch !== 'object') {
      return { status: 400, body: { error: 'patch is required' } };
    }

    const updated = ctx.tags.update(payload.path, payload.patch);
    return { status: 200, body: { path: payload.path, meta: updated } };
  }

  if (method === 'POST' && pathname === '/api/bulk-client') {
    const payload = body as { paths?: string[]; client?: string | null };
    if (!payload || !Array.isArray(payload.paths) || payload.paths.length === 0) {
      return { status: 400, body: { error: 'paths must be a non-empty array' } };
    }

    ctx.tags.bulkAssignClient(payload.paths, payload.client ?? null);
    return { status: 200, body: { updated: payload.paths.length } };
  }

  if (method === 'GET' && pathname === '/api/meta') {
    return {
      status: 200,
      body: {
        clients: ctx.tags.listClients(),
        tags: ctx.tags.listTags(),
        projects: ctx.tags.all(),
      },
    };
  }

  return { status: 404, body: { error: 'Not found' } };
}

/** Keeps the idle threshold inside a sane band; anything outside is a typo, not a preference. */
export function clampIdle(raw: string | null): number {
  if (!raw) return DEFAULT_IDLE_SECONDS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_IDLE_SECONDS;
  return Math.min(3600, Math.max(30, Math.round(parsed)));
}
