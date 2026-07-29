import { CacheManager } from '../../src/core/cache-manager.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('CacheManager', () => {
  let tempDir: string;
  let cache: CacheManager;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'claude-meter-cache-'));
    cache = new CacheManager(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns null when no cache exists', () => {
    expect(cache.read()).toBeNull();
  });

  it('writes and reads cache data', () => {
    const data = { today: { tokens: 1000, cost: 5.00 } };
    cache.write(data);
    const result = cache.read();
    expect(result?.data).toEqual(data);
  });

  it('includes timestamp in cache entry', () => {
    cache.write({ test: true });
    const result = cache.read();
    expect(result?.timestamp).toBeDefined();
    expect(new Date(result!.timestamp).getTime()).toBeGreaterThan(0);
  });

  it('reports cache as stale after TTL', () => {
    cache.write({ test: true });
    expect(cache.isStale(0)).toBe(true); // 0 second TTL = always stale
  });

  it('reports cache as fresh within TTL', () => {
    cache.write({ test: true });
    expect(cache.isStale(300)).toBe(false); // 5 min TTL
  });

  it('handles corrupt cache file gracefully', () => {
    writeFileSync(join(tempDir, 'cache.json'), 'NOT JSON');
    expect(cache.read()).toBeNull();
  });

  it('reports stale when no cache exists', () => {
    expect(cache.isStale(300)).toBe(true);
  });
});
