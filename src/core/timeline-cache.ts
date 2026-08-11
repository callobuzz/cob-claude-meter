import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  writeSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Interval, TimingSource } from './time-tracker.js';

/**
 * Cache format version — bump to invalidate every entry after a logic change.
 *
 * 3 moved from a single JSON object to newline-delimited records so the file can
 * be appended to instead of rewritten whole.
 */
const CACHE_VERSION = 4;

const CACHE_FILE = 'timeline-cache.ndjson';
/** The pre-v3 single-object file, removed on first load so it stops taking up space. */
const LEGACY_CACHE_FILE = 'timeline-cache.json';

/**
 * Compact once the file carries this multiple of the live entry count.
 *
 * Appending leaves superseded copies behind, so the file grows faster than the
 * data does. Rewriting on every save would defeat the point of appending; 2x
 * keeps the wasted space bounded while leaving most saves as cheap appends.
 */
const COMPACT_RATIO = 2;

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface CachedTimeline {
  mtimeMs: number;
  size: number;
  idleSeconds: number;
  /** Which method produced `intervals` — see TimingSource. */
  source: TimingSource;
  intervals: Interval[];
  cwds: Array<[string, number]>;
  firstSeen: number | null;
  lastSeen: number | null;
}

/** One line of the cache file: the session path plus its entry. */
interface CacheRecord extends CachedTimeline {
  path: string;
}

export type SaveResult = { ok: true } | { ok: false; reason: string };

/**
 * Per-file timeline cache keyed on mtime + size.
 *
 * Session logs routinely exceed 100MB and only the newest few change between
 * dashboard loads, so re-reading everything on every request is the difference
 * between an instant page and a minute of disk churn. An append changes both
 * mtime and size, so the key catches real edits without hashing the contents.
 *
 * The file is newline-delimited and written by appending only what changed.
 * The previous format serialised every session into one string and handed it to
 * a single `writeFileSync`; across a year of sessions that becomes a multi-
 * megabyte allocation written in one syscall, which is what returned ENOMEM on
 * a Docker Desktop bind mount and took the whole request down with it. Records
 * are now written one at a time, so peak memory is one record regardless of how
 * much history has accumulated.
 */
export class TimelineCache {
  private readonly cacheDir: string;
  private readonly cachePath: string;
  private sessions: Record<string, CachedTimeline> = {};
  /** Paths written since the last save — the only ones an append has to emit. */
  private pending = new Set<string>();
  /** Records physically in the file, including superseded ones. */
  private recordsOnDisk = 0;
  /** Set when entries were removed, which an append cannot express. */
  private needsCompaction = false;
  private hits = 0;
  private misses = 0;

  constructor(cacheDir: string) {
    this.cacheDir = cacheDir;
    this.cachePath = join(cacheDir, CACHE_FILE);
  }

  load(): void {
    // A v2-or-earlier cache cannot be migrated — the entries lack the fields the
    // current reader needs — so drop it rather than leave it sitting on disk.
    const legacy = join(this.cacheDir, LEGACY_CACHE_FILE);
    if (existsSync(legacy)) {
      try {
        unlinkSync(legacy);
      } catch {
        // Read-only mount; harmless, it is simply ignored from here on.
      }
    }

    if (!existsSync(this.cachePath)) return;

    try {
      const text = readFileSync(this.cachePath, 'utf-8');
      const lines = text.split('\n');
      let header = false;
      let count = 0;

      for (const line of lines) {
        if (!line) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          // A torn final line from an interrupted append. Everything before it
          // is still valid, so keep going rather than discarding the file.
          continue;
        }

        if (!header) {
          const v = (parsed as { v?: number }).v;
          if (v !== CACHE_VERSION) return; // stale format: start empty
          header = true;
          continue;
        }

        const record = parsed as CacheRecord;
        if (!record || typeof record.path !== 'string') continue;
        const { path, ...entry } = record;
        // Later lines supersede earlier ones for the same path.
        this.sessions[path] = entry;
        count++;
      }

      if (!header) {
        this.sessions = {};
        return;
      }
      this.recordsOnDisk = count;
    } catch {
      // Unreadable cache is not worth recovering — a rescan rebuilds it.
      this.sessions = {};
    }
  }

  /**
   * Returns the cached timeline if the file is unchanged and the entry still
   * applies.
   *
   * Every entry depends on the threshold, turn-measured ones included: the
   * stretches *between* measured spans are joined or split by it, so a total
   * computed at 5 minutes is not valid at 10. An earlier version reused
   * turn-measured entries across a change, which made switching the setting
   * instant by serving the previous setting's numbers.
   */
  get(filePath: string, idleSeconds: number): CachedTimeline | null {
    const entry = this.sessions[filePath];
    if (!entry) {
      this.misses++;
      return null;
    }
    if (entry.idleSeconds !== idleSeconds) {
      this.misses++;
      return null;
    }

    try {
      const stat = statSync(filePath);
      if (stat.mtimeMs !== entry.mtimeMs || stat.size !== entry.size) {
        this.misses++;
        return null;
      }
    } catch {
      this.misses++;
      return null;
    }

    this.hits++;
    return entry;
  }

  set(filePath: string, entry: Omit<CachedTimeline, 'mtimeMs' | 'size'>): void {
    try {
      const stat = statSync(filePath);
      this.sessions[filePath] = { ...entry, mtimeMs: stat.mtimeMs, size: stat.size };
      this.pending.add(filePath);
    } catch {
      // File vanished mid-scan; nothing worth caching.
    }
  }

  /** Drops entries for files that no longer exist so the cache cannot grow forever. */
  prune(livePaths: Set<string>): void {
    for (const key of Object.keys(this.sessions)) {
      if (!livePaths.has(key)) {
        delete this.sessions[key];
        this.pending.delete(key);
        // A removal cannot be appended, only rewritten.
        this.needsCompaction = true;
      }
    }
  }

  /**
   * Persists the cache. Never throws.
   *
   * The cache is an optimisation, not data: losing a write costs one slow
   * rescan, so a failure here must not take down the request that triggered it.
   * Returns the reason on failure so the caller can surface it as a warning
   * rather than swallowing it.
   */
  save(): SaveResult {
    if (!this.needsCompaction && this.pending.size === 0) return { ok: true };

    try {
      if (!existsSync(this.cacheDir)) {
        mkdirSync(this.cacheDir, { recursive: true });
      }
    } catch (err) {
      return { ok: false, reason: describe(err) };
    }

    const liveCount = Object.keys(this.sessions).length;
    const shouldCompact =
      this.needsCompaction ||
      !existsSync(this.cachePath) ||
      this.recordsOnDisk + this.pending.size > Math.max(32, liveCount * COMPACT_RATIO);

    // One retry: the same transient bind-mount failure the session reader retries on.
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (shouldCompact) this.compactFile();
        else this.appendPending();
        this.pending.clear();
        this.needsCompaction = false;
        return { ok: true };
      } catch (err) {
        lastError = err;
      }
    }

    return { ok: false, reason: describe(lastError) };
  }

  /** Appends only the records written since the last save. */
  private appendPending(): void {
    const fd = openSync(this.cachePath, 'a');
    try {
      for (const path of this.pending) {
        const entry = this.sessions[path];
        if (!entry) continue;
        writeSync(fd, JSON.stringify({ path, ...entry }) + '\n');
        this.recordsOnDisk++;
      }
    } finally {
      closeSync(fd);
    }
  }

  /**
   * Rewrites the file with exactly the live entries, one record per write.
   *
   * Goes through a temp file so an interrupted rewrite cannot leave a truncated
   * cache in place.
   */
  private compactFile(): void {
    const tmpPath = join(this.cacheDir, `timeline-${randomBytes(4).toString('hex')}.tmp`);
    let fd: number | null = null;

    try {
      fd = openSync(tmpPath, 'w');
      writeSync(fd, JSON.stringify({ v: CACHE_VERSION }) + '\n');

      let count = 0;
      for (const [path, entry] of Object.entries(this.sessions)) {
        writeSync(fd, JSON.stringify({ path, ...entry }) + '\n');
        count++;
      }

      closeSync(fd);
      fd = null;

      renameSync(tmpPath, this.cachePath);
      this.recordsOnDisk = count;
    } catch (err) {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // Already closed or never opened cleanly.
        }
      }
      // A half-written temp file would otherwise accumulate on every failure.
      try {
        if (existsSync(tmpPath)) unlinkSync(tmpPath);
      } catch {
        // Best effort — a stray temp file is litter, not a fault.
      }
      throw err;
    }
  }

  /** Removes temp files a previous crash left behind. */
  sweepTempFiles(): number {
    let removed = 0;
    try {
      for (const name of readdirSync(this.cacheDir)) {
        if (!/^timeline-[0-9a-f]{8}\.tmp$/.test(name)) continue;
        try {
          unlinkSync(join(this.cacheDir, name));
          removed++;
        } catch {
          // Locked or already gone; nothing to do.
        }
      }
    } catch {
      // No cache dir yet.
    }
    return removed;
  }

  getStats(): { hits: number; misses: number } {
    return { hits: this.hits, misses: this.misses };
  }

  /** Live entry count and how many records the file physically holds. */
  getFileStats(): { entries: number; recordsOnDisk: number } {
    return { entries: Object.keys(this.sessions).length, recordsOnDisk: this.recordsOnDisk };
  }
}
