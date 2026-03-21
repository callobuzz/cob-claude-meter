import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '../core/config-manager.js';
import { discoverLogPaths, validatePath } from '../core/path-resolver.js';
import { getPricingVersion, getAllModelIds } from '../core/pricing.js';
import { CacheManager } from '../core/cache-manager.js';

export async function runDoctorCommand(): Promise<string> {
  const mgr = new ConfigManager();
  const configDir = mgr.getConfigDir();
  const configPath = join(configDir, 'config.json');
  const config = mgr.load();

  const lines: string[] = ['Claude Meter Doctor', ''];

  // Config status
  const configExists = existsSync(configPath);
  lines.push(`  Config:     ${configPath} ${configExists ? '\u2713' : '\u2717 not found'}`);

  // Pricing status
  try {
    const version = getPricingVersion();
    lines.push(`  Pricing:    bundled (${version}) \u2713`);
  } catch {
    lines.push('  Pricing:    \u2717 could not load bundled pricing');
  }

  // Cache status
  const cache = new CacheManager(configDir);
  const cacheEntry = cache.read();
  if (cacheEntry) {
    const ageMs = Date.now() - new Date(cacheEntry.timestamp).getTime();
    const ageMin = Math.round(ageMs / 60_000);
    const stale = cache.isStale(config.statusline.refreshCache);
    lines.push(`  Cache:      ${stale ? '\u2717 stale' : '\u2713 valid'}, ${ageMin} min old`);
  } else {
    lines.push('  Cache:      \u2717 not found');
  }

  lines.push('');

  // Log paths
  const configuredPaths = config.logPaths;
  const autoDetected = discoverLogPaths();
  const allPaths = new Map<string, string>();
  for (const p of configuredPaths) allPaths.set(p, 'config');
  for (const p of autoDetected) {
    if (!allPaths.has(p)) allPaths.set(p, 'auto-detected');
  }

  lines.push('  Log Paths:');
  if (allPaths.size === 0) {
    lines.push('    (none detected)');
  } else {
    for (const [pathStr] of allPaths) {
      const validation = validatePath(pathStr);
      lines.push(`    ${pathStr}`);
      lines.push(`      Status:    ${validation.valid ? '\u2713 accessible' : `\u2717 ${validation.error ?? 'not accessible'}`}`);
      if (validation.valid) {
        lines.push(`      Files:     ${validation.fileCount.toLocaleString()} .jsonl files`);
      }
    }
  }

  lines.push('');

  // Models in bundled pricing
  try {
    const modelIds = getAllModelIds();
    lines.push(`  Models in bundled pricing:`);
    lines.push(`    ${modelIds.join(', ')}`);
  } catch {
    lines.push('  Models:     \u2717 could not load');
  }

  lines.push('');

  // Overall verdict
  const hasAccessiblePaths = [...allPaths.keys()].some(p => validatePath(p).valid);
  if (hasAccessiblePaths) {
    lines.push('  Everything looks good \u2713');
  } else {
    lines.push('  \u2717 No accessible log paths found. Run `claude-meter setup` to configure.');
  }

  return lines.join('\n');
}
