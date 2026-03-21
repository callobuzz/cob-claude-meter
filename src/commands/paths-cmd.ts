import { ConfigManager } from '../core/config-manager.js';
import { discoverLogPaths, validatePath } from '../core/path-resolver.js';

export async function runPathsCommand(): Promise<string> {
  const mgr = new ConfigManager();
  const config = mgr.load();

  const configuredPaths = config.logPaths;
  const autoDetected = discoverLogPaths();

  // Merge: config paths first, then auto-detected that aren't already listed
  const allPaths = new Map<string, 'config' | 'auto-detected'>();
  for (const p of configuredPaths) {
    allPaths.set(p, 'config');
  }
  for (const p of autoDetected) {
    if (!allPaths.has(p)) {
      allPaths.set(p, 'auto-detected');
    }
  }

  if (allPaths.size === 0) {
    return 'No log paths configured or detected.\nRun `claude-meter setup` to configure.';
  }

  const lines: string[] = ['Log Paths:', ''];

  for (const [pathStr, source] of allPaths) {
    const validation = validatePath(pathStr);
    const status = validation.valid ? '\u2713 accessible' : `\u2717 ${validation.error ?? 'not accessible'}`;
    const fileCount = validation.valid
      ? `${validation.fileCount.toLocaleString()} .jsonl files`
      : 'n/a';

    lines.push(`  ${pathStr}`);
    lines.push(`    Source:  ${source}`);
    lines.push(`    Status:  ${status}`);
    lines.push(`    Files:   ${fileCount}`);
    lines.push('');
  }

  return lines.join('\n');
}
