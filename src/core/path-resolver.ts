import { existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface PathValidation {
  valid: boolean;
  fileCount: number;
  error?: string;
}

/**
 * Returns platform-specific default paths where Claude Code logs may reside.
 */
export function getDefaultPaths(): string[] {
  const home = homedir();
  const paths: string[] = [join(home, '.claude', 'projects')];

  const platform = process.platform;
  if (platform === 'win32') {
    const appData = process.env['APPDATA'];
    if (appData) {
      paths.push(join(appData, 'claude', 'projects'));
    }
  } else if (platform === 'darwin') {
    paths.push(join(home, 'Library', 'Application Support', 'claude', 'projects'));
  } else {
    // Linux and other Unix-like
    paths.push(join(home, '.config', 'claude', 'projects'));
  }

  return paths;
}

/**
 * Filters getDefaultPaths() to only directories that actually exist.
 */
export function discoverLogPaths(): string[] {
  return getDefaultPaths().filter(p => {
    try {
      return existsSync(p) && statSync(p).isDirectory();
    } catch {
      return false;
    }
  });
}

/**
 * Validates a directory path: checks existence, directory status, and counts .jsonl files recursively.
 */
export function validatePath(dirPath: string): PathValidation {
  try {
    if (!existsSync(dirPath)) {
      return { valid: false, fileCount: 0, error: 'Path does not exist' };
    }
    const stat = statSync(dirPath);
    if (!stat.isDirectory()) {
      return { valid: false, fileCount: 0, error: 'Path is not a directory' };
    }
    const files = findJsonlFiles(dirPath);
    return { valid: true, fileCount: files.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { valid: false, fileCount: 0, error: message };
  }
}

/**
 * Recursively finds all .jsonl files in a directory.
 */
export function findJsonlFiles(dirPath: string): string[] {
  const results: string[] = [];
  collectJsonlFiles(dirPath, results);
  return results;
}

function collectJsonlFiles(dirPath: string, results: string[]): void {
  let entries;
  try {
    entries = readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      collectJsonlFiles(fullPath, results);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      results.push(fullPath);
    }
  }
}
