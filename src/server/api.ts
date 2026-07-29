import { DateRangeLabel, getDateRange } from '../core/date-ranges.js';
import { ProjectTime, TimeReport, buildTimeReport } from '../core/time-aggregator.js';
import { TimelineCache } from '../core/timeline-cache.js';
import { ProjectMeta, TagStore } from '../core/tag-store.js';
import { DEFAULT_IDLE_SECONDS } from '../core/time-tracker.js';

export interface ApiContext {
  logPaths: string[];
  tags: TagStore;
  cache: TimelineCache;
  /** Reports are memoised for this long so rapid filter changes do not rescan. */
  reportTtlMs: number;
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

export interface DecoratedProject extends ProjectTime {
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

/** Drops the in-memory report cache. Exported for tests and for forced refreshes. */
export function invalidateReportCache(): void {
  memo = null;
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
  return {
    ...project,
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

  const report = await buildTimeReport({
    logPaths: ctx.logPaths,
    idleSeconds,
    start,
    end,
    cache: ctx.cache,
  });

  memo = { key, builtAt: Date.now(), report };
  return report;
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
