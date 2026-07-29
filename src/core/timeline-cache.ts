import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Interval } from './time-tracker.js';

/** Cache format version — bump to invalidate every entry after a logic change. */
const CACHE_VERSION = 1;

export interface CachedTimeline {
  mtimeMs: number;
  size: number;
  idleSeconds: number;
  intervals: Interval[];
  cwds: Array<[string, number]>;
  firstSeen: number | null;
  lastSeen: number | null;
}

interface CacheFile {
  version: number;
  sessions: Record<string, CachedTimeline>;
}

/**
 * Per-file timeline cache keyed on mtime + size.
 *
 * Session logs routinely exceed 100MB and only the newest few change between
 * dashboard loads, so re-reading everything on every request is the difference
 * between an instant page and a minute of disk churn. An append changes both
 * mtime and size, so the key catches real edits without hashing the contents.
 */
export class TimelineCache {
  private readonly cacheDir: string;
  private readonly cachePath: string;
  private sessions: Record<string, CachedTimeline> = {};
  private dirty = false;
  private hits = 0;
  private misses = 0;

  constructor(cacheDir: string) {
    this.cacheDir = cacheDir;
    this.cachePath = join(cacheDir, 'timeline-cache.json');
  }

  load(): void {
    if (!existsSync(this.cachePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.cachePath, 'utf-8')) as CacheFile;
      if (parsed.version === CACHE_VERSION && parsed.sessions) {
        this.sessions = parsed.sessions;
      }
    } catch {
      // Corrupt cache is not worth recovering — a rescan rebuilds it.
    }
  }

  /** Returns the cached timeline if the file is unchanged and the threshold matches. */
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
      this.dirty = true;
    } catch {
      // File vanished mid-scan; nothing worth caching.
    }
  }

  /** Drops entries for files that no longer exist so the cache cannot grow forever. */
  prune(livePaths: Set<string>): void {
    for (const key of Object.keys(this.sessions)) {
      if (!livePaths.has(key)) {
        delete this.sessions[key];
        this.dirty = true;
      }
    }
  }

  save(): void {
    if (!this.dirty) return;
    if (!existsSync(this.cacheDir)) {
      mkdirSync(this.cacheDir, { recursive: true });
    }
    const payload: CacheFile = { version: CACHE_VERSION, sessions: this.sessions };
    const tmpPath = join(this.cacheDir, `timeline-${randomBytes(4).toString('hex')}.tmp`);
    writeFileSync(tmpPath, JSON.stringify(payload), 'utf-8');
    renameSync(tmpPath, this.cachePath);
    this.dirty = false;
  }

  getStats(): { hits: number; misses: number } {
    return { hits: this.hits, misses: this.misses };
  }
}
