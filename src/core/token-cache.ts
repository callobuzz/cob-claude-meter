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
import type { SaveResult } from './timeline-cache.js';

/** Cache format version — bump to invalidate every entry after a shape change. */
const CACHE_VERSION = 1;

const CACHE_FILE = 'token-cache.ndjson';

/** Same growth bound the timeline cache uses: rewrite once waste reaches 2x live. */
const COMPACT_RATIO = 2;

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * One model's counters for one day, packed positionally.
 *
 * A year of logs is thousands of project-day-model rows, and spelling out
 * `cache_creation_input_tokens` on each one costs more bytes than the numbers
 * do. The order is fixed and must not be reshuffled without a version bump.
 */
export type PackedTokens = [
  input: number,
  output: number,
  cacheRead: number,
  cacheCreate: number,
  cache5m: number,
  cache1h: number,
  webSearches: number,
  webFetches: number,
  entries: number,
];

export function emptyPacked(): PackedTokens {
  return [0, 0, 0, 0, 0, 0, 0, 0, 0];
}

export interface CachedTokens {
  mtimeMs: number;
  size: number;
  /**
   * Local day → session ids active that day.
   *
   * Scoped per day rather than per file so a narrow range counts only the
   * sessions that actually ran in it. A file spanning two months would
   * otherwise report its session against both.
   */
  daySessions: Record<string, string[]>;
  cwds: Array<[string, number]>;
  firstSeen: number | null;
  lastSeen: number | null;
  /** Local day → model → counters. */
  days: Record<string, Record<string, PackedTokens>>;
}

interface CacheRecord extends CachedTokens {
  path: string;
}

/**
 * Per-file token cache keyed on mtime + size.
 *
 * Deliberately stores the full per-day, per-model breakdown rather than a total
 * for one date range. Scanning is the expensive part and it does not get cheaper
 * for a narrow range — `scanFile` reads every line of every file regardless,
 * because the date filter is applied per entry. Measured on a real log
 * directory, `today` and `all` both cost about 8.6 seconds. Keeping the
 * breakdown means that cost is paid once and every subsequent range, from a
 * single day to all time, is answered by summing numbers already in memory.
 *
 * Unlike the timeline cache there is no threshold in the key: token counts are
 * absolute facts about a log line, so an entry stays valid no matter what the
 * viewer changes.
 */
export class TokenCache {
  private readonly cacheDir: string;
  private readonly cachePath: string;
  private files: Record<string, CachedTokens> = {};
  private pending = new Set<string>();
  private recordsOnDisk = 0;
  private needsCompaction = false;
  private hits = 0;
  private misses = 0;

  constructor(cacheDir: string) {
    this.cacheDir = cacheDir;
    this.cachePath = join(cacheDir, CACHE_FILE);
  }

  load(): void {
    if (!existsSync(this.cachePath)) return;

    try {
      const text = readFileSync(this.cachePath, 'utf-8');
      let header = false;
      let count = 0;

      for (const line of text.split('\n')) {
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
          if ((parsed as { v?: number }).v !== CACHE_VERSION) return;
          header = true;
          continue;
        }

        const record = parsed as CacheRecord;
        if (!record || typeof record.path !== 'string' || !record.days) continue;
        const { path, ...entry } = record;
        this.files[path] = entry;
        count++;
      }

      if (!header) {
        this.files = {};
        return;
      }
      this.recordsOnDisk = count;
    } catch {
      // Unreadable cache is not worth recovering — a rescan rebuilds it.
      this.files = {};
    }
  }

  get(filePath: string): CachedTokens | null {
    const entry = this.files[filePath];
    if (!entry) {
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

  set(filePath: string, entry: Omit<CachedTokens, 'mtimeMs' | 'size'>): void {
    try {
      const stat = statSync(filePath);
      this.files[filePath] = { ...entry, mtimeMs: stat.mtimeMs, size: stat.size };
      this.pending.add(filePath);
    } catch {
      // File vanished mid-scan; nothing worth caching.
    }
  }

  /** Drops entries for files that no longer exist so the cache cannot grow forever. */
  prune(livePaths: Set<string>): void {
    for (const key of Object.keys(this.files)) {
      if (!livePaths.has(key)) {
        delete this.files[key];
        this.pending.delete(key);
        this.needsCompaction = true;
      }
    }
  }

  /**
   * Persists the cache. Never throws.
   *
   * Losing a write costs one slow rescan, so a failure here must not take down
   * the request that triggered it. The reason comes back so the caller can
   * surface it as a warning instead of silently looking healthy.
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

    const liveCount = Object.keys(this.files).length;
    const shouldCompact =
      this.needsCompaction ||
      !existsSync(this.cachePath) ||
      this.recordsOnDisk + this.pending.size > Math.max(32, liveCount * COMPACT_RATIO);

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

  private appendPending(): void {
    const fd = openSync(this.cachePath, 'a');
    try {
      for (const path of this.pending) {
        const entry = this.files[path];
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
   * cache in place, and writes record-by-record so peak memory is one record
   * however much history has accumulated.
   */
  private compactFile(): void {
    const tmpPath = join(this.cacheDir, `token-${randomBytes(4).toString('hex')}.tmp`);
    let fd: number | null = null;

    try {
      fd = openSync(tmpPath, 'w');
      writeSync(fd, JSON.stringify({ v: CACHE_VERSION }) + '\n');

      let count = 0;
      for (const [path, entry] of Object.entries(this.files)) {
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
      try {
        if (existsSync(tmpPath)) unlinkSync(tmpPath);
      } catch {
        // Best effort — a stray temp file is litter, not a fault.
      }
      throw err;
    }
  }

  /**
   * Removes temp files a previous crash left behind.
   *
   * Scoped to this cache's own prefix so it cannot delete the timeline cache's
   * in-progress rewrite running in the same directory.
   */
  sweepTempFiles(): number {
    let removed = 0;
    try {
      for (const name of readdirSync(this.cacheDir)) {
        if (!/^token-[0-9a-f]{8}\.tmp$/.test(name)) continue;
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

  getFileStats(): { entries: number; recordsOnDisk: number } {
    return { entries: Object.keys(this.files).length, recordsOnDisk: this.recordsOnDisk };
  }
}
