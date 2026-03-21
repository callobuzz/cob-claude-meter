import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface CacheEntry {
  timestamp: string;
  data: unknown;
}

export class CacheManager {
  private cachePath: string;
  private cacheDir: string;

  constructor(cacheDir: string) {
    this.cacheDir = cacheDir;
    this.cachePath = join(cacheDir, 'cache.json');
  }

  read(): CacheEntry | null {
    if (!existsSync(this.cachePath)) return null;
    try {
      return JSON.parse(readFileSync(this.cachePath, 'utf-8'));
    } catch {
      return null;
    }
  }

  write(data: unknown): void {
    if (!existsSync(this.cacheDir)) {
      mkdirSync(this.cacheDir, { recursive: true });
    }
    const entry: CacheEntry = {
      timestamp: new Date().toISOString(),
      data,
    };
    const tmpPath = join(this.cacheDir, `cache-${randomBytes(4).toString('hex')}.tmp`);
    writeFileSync(tmpPath, JSON.stringify(entry), 'utf-8');
    renameSync(tmpPath, this.cachePath);
  }

  isStale(ttlSeconds: number): boolean {
    const entry = this.read();
    if (!entry) return true;
    const age = (Date.now() - new Date(entry.timestamp).getTime()) / 1000;
    return age > ttlSeconds;
  }
}
