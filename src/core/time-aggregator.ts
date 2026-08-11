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
  toLocalDayKey,
} from './time-tracker.js';
import { TimelineCache } from './timeline-cache.js';
import { ALGO_VERSION, ArchivedDay, DayArchive, dayFullyInRange } from './day-archive.js';

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
    /**
     * Project-days served from the archive because the logs no longer produce
     * them — history that would otherwise have vanished with the transcripts.
     */
    daysRestored: number;
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
  /**
   * Durable record of finished days. Supplied, the report writes every complete
   * day it computed and reads back any day whose logs have since been deleted.
   * Omitted, the report is exactly as before — logs only.
   */
  archive?: DayArchive;
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

/** Backoff between read attempts. Length is the retry budget for one file. */
const READ_RETRY_DELAYS_MS = [120, 400, 1200, 3000];

/**
 * Reads one session, retrying with backoff on a transient failure.
 *
 * Container bind mounts (Docker Desktop on Windows especially) return ENOMEM
 * when a cold scan pushes hundreds of megabytes through the filesystem layer
 * back to back. The failure is pressure, not corruption: the same file reads
 * fine once the layer drains.
 *
 * A single quick retry was not enough. On a 1.26GB log directory it left 21 of
 * 89 sessions unread in one pass, and because a skipped file is simply excluded
 * the dashboard reported 21 hours instead of 121 — wrong, not obviously broken.
 * Backing off further recovers them inside the same request.
 *
 * If every attempt fails the caller still skips that file rather than failing
 * the whole report, and the gap is surfaced as a warning.
 */
async function scanWithRetry(
  filePath: string,
  read: (p: string) => Promise<SessionScan>,
): Promise<SessionScan> {
  let firstError: unknown = null;

  for (let attempt = 0; ; attempt++) {
    try {
      return await read(filePath);
    } catch (err) {
      if (firstError === null) firstError = err;
      if (attempt >= READ_RETRY_DELAYS_MS.length) throw firstError;
      await sleep(READ_RETRY_DELAYS_MS[attempt]);
    }
  }
}

export function findProjectDirs(logRoot: string): string[] {
  try {
    return readdirSync(logRoot, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => join(logRoot, e.name));
  } catch {
    return [];
  }
}

export function leafName(projectPath: string): string {
  const segments = projectPath.split(/[\\/]+/).filter(Boolean);
  return segments[segments.length - 1] ?? projectPath;
}

/**
 * One project's running totals, before it becomes a ProjectTime.
 *
 * Summed time is carried separately from the intervals rather than re-derived
 * from them, because archived days arrive as a merged union plus a summed
 * total. Two overlapping sessions sum to more than their union, and only the
 * archive still knows by how much once the logs are gone.
 */
interface ProjectAccum {
  path: string;
  name: string;
  summedMs: number;
  intervals: Interval[];
  sessions: SessionSummary[];
  /** Sessions counted from archived days, whose per-session detail is not kept. */
  archivedSessions: number;
  byDay: Record<string, number>;
  firstSeen: number | null;
  lastSeen: number | null;
}

interface DayBucket {
  summed: number;
  intervals: Interval[];
  byProject: Map<string, number>;
}

function addToDay(
  dayTotals: Map<string, DayBucket>,
  day: string,
  projectPath: string,
  ms: number,
  intervals: Interval[],
): void {
  let bucket = dayTotals.get(day);
  if (!bucket) {
    bucket = { summed: 0, intervals: [], byProject: new Map() };
    dayTotals.set(day, bucket);
  }
  bucket.summed += ms;
  bucket.intervals.push(...intervals);
  bucket.byProject.set(projectPath, (bucket.byProject.get(projectPath) ?? 0) + ms);
}

/**
 * True when writing `fresh` over `existing` would lose recorded time.
 *
 * Claude Code deletes transcripts once they age past `cleanupPeriodDays`, and
 * it deletes them one session at a time — so a day at the edge of the retention
 * window recomputes smaller and smaller as its sessions disappear. Without this
 * the archive would faithfully record that decay and the history it exists to
 * protect would drain away silently.
 *
 * Only a like-for-like comparison counts. A different threshold or a change to
 * the timing rules is a legitimate reason for the number to move in either
 * direction, so those always overwrite.
 */
function wouldErode(existing: ArchivedDay | null, fresh: ArchivedDay): boolean {
  if (!existing) return false;
  if (existing.idleSeconds !== fresh.idleSeconds || existing.algo !== fresh.algo) return false;
  return fresh.totalMs < existing.totalMs;
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
  const archive = options.archive;
  const accums = new Map<string, ProjectAccum>();
  const dayTotals = new Map<string, DayBucket>();
  /** `${day} ${project}` pairs the logs produced, so the archive cannot double them. */
  const livePairs = new Set<string>();

  for (const { path: projectPath, sessions } of merged.values()) {
    const accum: ProjectAccum = {
      path: projectPath,
      name: leafName(projectPath),
      summedMs: 0,
      intervals: [],
      sessions: [],
      archivedSessions: 0,
      byDay: {},
      firstSeen: null,
      lastSeen: null,
    };
    /** This project's work split by day, kept only long enough to archive it. */
    const perDay = new Map<string, { ms: number; intervals: Interval[]; sessions: Set<string> }>();

    for (const session of sessions) {
      const clipped = clipToRange(session.intervals, rangeStart, rangeEnd);
      if (clipped.length === 0) continue;

      accum.intervals.push(...clipped);

      const activeMs = sumDuration(clipped);
      accum.summedMs += activeMs;
      const sessionFirst = clipped[0][0];
      const sessionLast = clipped[clipped.length - 1][1];

      accum.sessions.push({
        id: session.id,
        activeMs,
        firstSeen: sessionFirst,
        lastSeen: sessionLast,
      });

      if (accum.firstSeen === null || sessionFirst < accum.firstSeen) accum.firstSeen = sessionFirst;
      if (accum.lastSeen === null || sessionLast > accum.lastSeen) accum.lastSeen = sessionLast;

      for (const interval of clipped) {
        for (const part of splitIntervalByDay(interval)) {
          const ms = part.interval[1] - part.interval[0];
          accum.byDay[part.day] = (accum.byDay[part.day] ?? 0) + ms;
          addToDay(dayTotals, part.day, projectPath, ms, [part.interval]);
          livePairs.add(`${part.day} ${projectPath.toLowerCase()}`);

          let shard = perDay.get(part.day);
          if (!shard) {
            shard = { ms: 0, intervals: [], sessions: new Set() };
            perDay.set(part.day, shard);
          }
          shard.ms += ms;
          shard.intervals.push(part.interval);
          shard.sessions.add(session.id);
        }
      }
    }

    if (accum.intervals.length === 0) continue;
    accums.set(projectPath.toLowerCase(), accum);

    // 4a. Record every finished day this project fully covered. A day only
    //     partly inside the range is skipped — half a day's numbers must not
    //     replace a whole one's.
    if (archive) {
      for (const [day, shard] of perDay) {
        if (!dayFullyInRange(day, rangeStart, rangeEnd)) continue;
        const fresh: ArchivedDay = {
          day,
          project: accum.path,
          name: accum.name,
          totalMs: shard.ms,
          intervals: mergeIntervals(shard.intervals),
          sessionCount: shard.sessions.size,
          idleSeconds,
          algo: ALGO_VERSION,
        };
        if (wouldErode(archive.get(day, accum.path), fresh)) continue;
        archive.put(fresh);
      }
    }
  }

  // 5. Put back the days the logs no longer hold. Claude Code's retention
  //    window is the only reason they are missing, so anything the archive has
  //    for a (project, day) the scan did not produce is history, not a
  //    duplicate.
  let daysRestored = 0;
  let restoredUnderOtherRules = 0;

  if (archive) {
    const startDay = toLocalDayKey(Math.max(0, rangeStart));
    // Clamped to today: ranges routinely end in the future ("this month"), and
    // an unclamped MAX_SAFE_INTEGER is not a date at all.
    const endDay = toLocalDayKey(Math.min(rangeEnd, Date.now()));

    for (const entry of archive.range(startDay, endDay)) {
      if (livePairs.has(`${entry.day} ${entry.project.toLowerCase()}`)) continue;
      if (!dayFullyInRange(entry.day, rangeStart, rangeEnd)) continue;

      const key = entry.project.toLowerCase();
      let accum = accums.get(key);
      if (!accum) {
        accum = {
          path: entry.project,
          name: entry.name,
          summedMs: 0,
          intervals: [],
          sessions: [],
          archivedSessions: 0,
          byDay: {},
          firstSeen: null,
          lastSeen: null,
        };
        accums.set(key, accum);
      }

      accum.summedMs += entry.totalMs;
      accum.intervals.push(...entry.intervals);
      accum.archivedSessions += entry.sessionCount;
      accum.byDay[entry.day] = (accum.byDay[entry.day] ?? 0) + entry.totalMs;
      for (const [a, b] of entry.intervals) {
        if (accum.firstSeen === null || a < accum.firstSeen) accum.firstSeen = a;
        if (accum.lastSeen === null || b > accum.lastSeen) accum.lastSeen = b;
      }

      addToDay(dayTotals, entry.day, accum.path, entry.totalMs, entry.intervals);
      daysRestored++;
      if (entry.idleSeconds !== idleSeconds || entry.algo !== ALGO_VERSION) restoredUnderOtherRules++;
    }
  }

  const archiveSaved = archive?.save();
  if (archiveSaved && !archiveSaved.ok) {
    warnings.push(`Day archive could not be saved (${archiveSaved.reason}); these days will be lost if the logs expire.`);
  }
  if (restoredUnderOtherRules > 0) {
    warnings.push(
      `${restoredUnderOtherRules} archived day(s) were measured at a different idle threshold or under older rules. ` +
      `Their logs are gone, so they cannot be recomputed — the stored numbers are shown as-is.`,
    );
  }

  const projects: ProjectTime[] = [];
  for (const accum of accums.values()) {
    if (accum.intervals.length === 0) continue;
    const mergedIntervals = mergeIntervals(accum.intervals);

    projects.push({
      id: accum.path,
      path: accum.path,
      name: accum.name,
      totalMs: accum.summedMs,
      wallClockMs: sumDuration(mergedIntervals),
      intervals: mergedIntervals,
      sessionCount: accum.sessions.length + accum.archivedSessions,
      sessions: accum.sessions.sort((a, b) => b.activeMs - a.activeMs),
      activeDays: Object.keys(accum.byDay).length,
      firstSeen: accum.firstSeen,
      lastSeen: accum.lastSeen,
      byDay: accum.byDay,
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
      daysRestored,
      durationMs: Date.now() - startedAt,
    },
    warnings,
  };
}
