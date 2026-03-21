import { getDefaultPaths, validatePath, discoverLogPaths } from '../../src/core/path-resolver.js';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('getDefaultPaths', () => {
  it('returns an array of paths', () => {
    const paths = getDefaultPaths();
    expect(Array.isArray(paths)).toBe(true);
    expect(paths.length).toBeGreaterThan(0);
  });

  it('includes home .claude/projects path', () => {
    const paths = getDefaultPaths();
    expect(paths.some(p => p.includes('.claude'))).toBe(true);
  });
});

describe('validatePath', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'claude-meter-path-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns valid for dir with jsonl files', () => {
    writeFileSync(join(tempDir, 'test.jsonl'), '{}');
    const result = validatePath(tempDir);
    expect(result.valid).toBe(true);
    expect(result.fileCount).toBe(1);
  });

  it('returns invalid for non-existent dir', () => {
    const result = validatePath('/nonexistent/path/xyz123');
    expect(result.valid).toBe(false);
  });

  it('returns valid but zero files for empty dir', () => {
    const result = validatePath(tempDir);
    expect(result.valid).toBe(true);
    expect(result.fileCount).toBe(0);
  });

  it('counts jsonl files recursively', () => {
    const sub = join(tempDir, 'sub');
    mkdirSync(sub);
    writeFileSync(join(tempDir, 'a.jsonl'), '{}');
    writeFileSync(join(sub, 'b.jsonl'), '{}');
    const result = validatePath(tempDir);
    expect(result.fileCount).toBe(2);
  });
});
