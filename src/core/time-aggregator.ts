import { readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  DEFAULT_IDLE_SECONDS,
  Interval,
  SessionScan,
  buildSessionIntervals,
  clipToRange,
  mergeIntervals,
  resolveProjectRoot,
  scanSessionTimestamps,
  splitIntervalByDay,
  sumDuration,
} from './time-tracker.js';
import { TimelineCache } from './timeline-cache.js';

export interface SessionSummary {
  id: string;
  activeMs: number;
  firstSeen: number | null;
  lastSeen: number | null;
}

export interface ProjectTime {
  /** Stable identity: the resolved project path. */
  id: string;
  path: string;
  /** Leaf folder, for display. */
  name: string;
  /** Summed across sessions — two terminals for an hour each counts as two hours. */
  totalMs: number;
  /** Union across this project's sessions — the same hour counted once. */
  wallClockMs: number;
  /**
   * The merged intervals `wallClockMs` sums, clipped to the range.
   *
   * Shipped so a client can re-derive wall-clock for any *subset* of projects.
   * Unions do not add, so a filtered wall-clock cannot be reconstructed from
   * per-project scalars — it needs the intervals themselves.
   */
  intervals: Interval[];
  sessionCount: number;
  sessions: SessionSummary[];
  activeDays: number;
  firstSeen: number | null;
  lastSeen: number | null;
  byDay: Record<string, number>;
}

export interface DayTime {
  day: string;
  totalMs: number;
  wallClockMs: number;
  projects: Array<{ id: string; name: string; ms: number }>;
}

export interface TimeReport {
  generatedAt: string;
  idleSeconds: number;
  range: { start: number; end: number };
  projects: ProjectTime[];
  days: DayTime[];
  totals: {
    totalMs: number;
    wallClockMs: number;
    activeDays: number;
    sessionCount: number;
    projectCount: number;
  };
  scan: {
    filesScanned: number;
    filesFromCache: number;
    filesFailed: number;
    /** Sessions whose time came from Claude Code's own turn records. */
    sessionsMeasured: number;
    /** Sessions with no turn records, whose time was inferred from entry spacing. */
    sessionsInferred: number;
    durationMs: number;
  };
  /** Non-fatal problems worth surfacing — a skipped log means undercounted hours. */
  warnings: string[];
}

export interface TimeReportOptions {
  logPaths: string[];
  idleSeconds?: number;
  start?: number;
  end?: number;
  cache?: TimelineCache;
  onProgress?: (done: number, total: number, label: string) => void;
  /** Override the session reader. Exists so the failure path can be tested. */
  scanner?: (filePath: string) => Promise<SessionScan>;
}

interface RawSession {
  filePath: string;
  id: string;
  intervals: Interval[];
  firstSeen: number | null;
  lastSeen: number | null;
}

interface Bucket {
  dirName: string;
  sessions: RawSession[];
  cwds: Map<string, number>;
}

/**
 * Finds the session logs for one project directory.
 *
 * Only top-level files count. Claude Code also writes subagent transcripts to
 * `<session-id>/subagents/*.jsonl`, but a subagent runs inside its parent
 * session — treating those as sessions would count the same terminal many
 * times over.
 */
function findSessionFiles(projectDir: string): string[] {
  try {
    return readdirSync(projectDir, { withFileTypes: true })
      .filter(e => e.isFile() && e.name.endsWith('.jsonl'))
      .map(e => join(projectDir, e.name));
  } catch {
    return [];
  }
}

const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));

/**
 * Reads one session, retrying once on a transient failure.
 *
 * Container bind mounts (Docker Desktop on Windows especially) can return
 * ENOMEM or EBUSY when a cold scan pushes hundreds of megabytes through the
 * filesystem layer at once. A retry clears it; if it does not, the caller skips
 * that file rather than failing the whole report.
 */
async function scanWithRetry(
  filePath: string,
  read: (p: string) => Promise<SessionScan>,
): Promise<SessionScan> {
  try {
    return await read(filePath);
  } catch (first) {
    await sleep(120);
    try {
      return await read(filePath);
    } catch {
      throw first;
    }
  }
}

function findProjectDirs(logRoot: string): string[] {
  try {
    return readdirSync(logRoot, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => join(logRoot, e.name));
  } catch {
    return [];
  }
}

function leafName(projectPath: string): string {
  const segments = projectPath.split(/[\\/]+/).filter(Boolean);
  return segments[segments.length - 1] ?? projectPath;
}

export async function buildTimeReport(options: TimeReportOptions): Promise<TimeReport> {
  const startedAt = Date.now();
  const idleSeconds = options.idleSeconds ?? DEFAULT_IDLE_SECONDS;
  const rangeStart = options.start ?? 0;
  const rangeEnd = options.end ?? Number.MAX_SAFE_INTEGER;
  const cache = options.cache;
  const read = options.scanner ?? scanSessionTimestamps;

  // 1. Enumerate every project directory and its session files.
  const projectDirs: string[] = [];
  for (const logRoot of options.logPaths) {
    projectDirs.push(...findProjectDirs(logRoot));
  }

  const work: Array<{ dir: string; files: string[] }> = [];
  const livePaths = new Set<string>();
  for (const dir of projectDirs) {
    const files = findSessionFiles(dir);
    if (files.length === 0) continue;
    for (const f of files) livePaths.add(f);
    work.push({ dir, files });
  }

  const totalFiles = work.reduce((acc, w) => acc + w.files.length, 0);
  let done = 0;
  let filesFromCache = 0;
  let filesFailed = 0;
  let sessionsMeasured = 0;
  let sessionsInferred = 0;
  const warnings: string[] = [];

  // 2. Read every session into intervals, reusing cached results where possible.
  const buckets: Bucket[] = [];

  for (const { dir, files } of work) {
    const bucket: Bucket = { dirName: basename(dir), sessions: [], cwds: new Map() };

    for (const filePath of files) {
      const cached = cache?.get(filePath, idleSeconds) ?? null;

      if (cached) {
        filesFromCache++;
        if (cached.source === 'turns') sessionsMeasured++;
        else if (cached.intervals.length > 0) sessionsInferred++;
        bucket.sessions.push({
          filePath,
          id: basename(filePath, '.jsonl'),
          intervals: cached.intervals,
          firstSeen: cached.firstSeen,
          lastSeen: cached.lastSeen,
        });
        for (const [p, n] of cached.cwds) {
          bucket.cwds.set(p, (bucket.cwds.get(p) ?? 0) + n);
        }
      } else {
        try {
          const scan = await scanWithRetry(filePath, read);
          const { timestamps, cwds } = scan;
          const { intervals, source } = buildSessionIntervals(scan, idleSeconds);
          const firstSeen = timestamps.length ? timestamps[0] : null;
          const lastSeen = timestamps.length ? timestamps[timestamps.length - 1] : null;

          if (source === 'turns') sessionsMeasured++;
          else if (intervals.length > 0) sessionsInferred++;

          bucket.sessions.push({
            filePath,
            id: basename(filePath, '.jsonl'),
            intervals,
            firstSeen,
            lastSeen,
          });
          for (const [p, n] of cwds) {
            bucket.cwds.set(p, (bucket.cwds.get(p) ?? 0) + n);
          }

          cache?.set(filePath, {
            idleSeconds,
            source,
            intervals,
            cwds: [...cwds.entries()],
            firstSeen,
            lastSeen,
          });
        } catch (err) {
          // One unreadable log must not take down the whole dashboard; report
          // the gap instead so the totals are visibly incomplete, not silently.
          filesFailed++;
          const reason = err instanceof Error ? err.message : String(err);
          warnings.push(`Skipped ${basename(filePath)}: ${reason}`);
        }
      }

      done++;
      options.onProgress?.(done, totalFiles, basename(filePath));
    }

    buckets.push(bucket);
  }

  cache?.prune(livePaths);
  const saved = cache?.save();
  if (saved && !saved.ok) {
    // The report itself is fine — only the cache write failed, so the next load
    // rescans instead of reusing this work. Say so rather than looking healthy.
    warnings.push(`Timeline cache could not be saved (${saved.reason}); the next load will be slower.`);
  }

  // 3. Resolve each directory to a real project path, then merge directories
  //    that point at the same place (a folder rename leaves two behind).
  const merged = new Map<string, { path: string; sessions: RawSession[] }>();

  for (const bucket of buckets) {
    const resolved = resolveProjectRoot(bucket.cwds) ?? bucket.dirName;
    const key = resolved.toLowerCase();
    const existing = merged.get(key);
    if (existing) {
      existing.sessions.push(...bucket.sessions);
    } else {
      merged.set(key, { path: resolved, sessions: [...bucket.sessions] });
    }
  }

  // 4. Roll up per project and per day.
  const projects: ProjectTime[] = [];
  const dayTotals = new Map<string, { summed: number; intervals: Interval[]; byProject: Map<string, number> }>();

  for (const { path: projectPath, sessions } of merged.values()) {
    const projectIntervals: Interval[] = [];
    const sessionSummaries: SessionSummary[] = [];
    const byDay: Record<string, number> = {};
    let firstSeen: number | null = null;
    let lastSeen: number | null = null;

    for (const session of sessions) {
      const clipped = clipToRange(session.intervals, rangeStart, rangeEnd);
      if (clipped.length === 0) continue;

      projectIntervals.push(...clipped);

      const activeMs = sumDuration(clipped);
      const sessionFirst = clipped[0][0];
      const sessionLast = clipped[clipped.length - 1][1];

      sessionSummaries.push({
        id: session.id,
        activeMs,
        firstSeen: sessionFirst,
        lastSeen: sessionLast,
      });

      if (firstSeen === null || sessionFirst < firstSeen) firstSeen = sessionFirst;
      if (lastSeen === null || sessionLast > lastSeen) lastSeen = sessionLast;

      for (const interval of clipped) {
        for (const part of splitIntervalByDay(interval)) {
          const ms = part.interval[1] - part.interval[0];
          byDay[part.day] = (byDay[part.day] ?? 0) + ms;

          let bucket = dayTotals.get(part.day);
          if (!bucket) {
            bucket = { summed: 0, intervals: [], byProject: new Map() };
            dayTotals.set(part.day, bucket);
          }
          bucket.summed += ms;
          bucket.intervals.push(part.interval);
          bucket.byProject.set(projectPath, (bucket.byProject.get(projectPath) ?? 0) + ms);
        }
      }
    }

    if (projectIntervals.length === 0) continue;

    const mergedIntervals = mergeIntervals(projectIntervals);

    projects.push({
      id: projectPath,
      path: projectPath,
      name: leafName(projectPath),
      totalMs: sumDuration(projectIntervals),
      wallClockMs: sumDuration(mergedIntervals),
      intervals: mergedIntervals,
      sessionCount: sessionSummaries.length,
      sessions: sessionSummaries.sort((a, b) => b.activeMs - a.activeMs),
      activeDays: Object.keys(byDay).length,
      firstSeen,
      lastSeen,
      byDay,
    });
  }

  projects.sort((a, b) => b.totalMs - a.totalMs);

  const days: DayTime[] = [...dayTotals.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([day, bucket]) => ({
      day,
      totalMs: bucket.summed,
      wallClockMs: sumDuration(mergeIntervals(bucket.intervals)),
      projects: [...bucket.byProject.entries()]
        .map(([id, ms]) => ({ id, name: leafName(id), ms }))
        .sort((a, b) => b.ms - a.ms),
    }));

  const allIntervals: Interval[] = [];
  for (const bucket of dayTotals.values()) allIntervals.push(...bucket.intervals);

  return {
    generatedAt: new Date().toISOString(),
    idleSeconds,
    range: { start: rangeStart, end: rangeEnd },
    projects,
    days,
    totals: {
      totalMs: projects.reduce((acc, p) => acc + p.totalMs, 0),
      wallClockMs: sumDuration(mergeIntervals(allIntervals)),
      activeDays: days.length,
      sessionCount: projects.reduce((acc, p) => acc + p.sessionCount, 0),
      projectCount: projects.length,
    },
    scan: {
      filesScanned: totalFiles,
      filesFromCache,
      filesFailed,
      sessionsMeasured,
      sessionsInferred,
      durationMs: Date.now() - startedAt,
    },
    warnings,
  };
}
