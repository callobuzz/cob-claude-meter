import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '../core/config-manager.js';
import { discoverLogPaths, validatePath } from '../core/path-resolver.js';
import { getAllModelIds, assessPricingStaleness, PRICING_STALE_AFTER_DAYS } from '../core/pricing.js';
import { CacheManager } from '../core/cache-manager.js';
import { readRetentionSetting, scanRetentionState } from '../core/retention.js';

export async function runDoctorCommand(): Promise<string> {
  const mgr = new ConfigManager();
  const configDir = mgr.getConfigDir();
  const configPath = join(configDir, 'config.json');
  const config = mgr.load();

  const lines: string[] = ['Claude Meter Doctor', ''];

  // Config status
  const configExists = existsSync(configPath);
  lines.push(`  Config:     ${configPath} ${configExists ? '\u2713' : '\u2717 not found'}`);

  // Pricing status. Age matters as much as presence: Anthropic ships models
  // faster than this package publishes, and an unknown model is silently
  // priced at flagship rates rather than failing loudly.
  try {
    const staleness = assessPricingStaleness();
    const mark = staleness.stale || staleness.overdue.length > 0 ? '\u2717' : '\u2713';
    lines.push(`  Pricing:    bundled (${staleness.version}, ${staleness.ageDays} days old) ${mark}`);
    for (const change of staleness.overdue) {
      lines.push(`              \u2717 ${change.model} rates changed on ${change.effective}; this build is behind`);
    }
    if (staleness.stale) {
      lines.push(`              Over ${PRICING_STALE_AFTER_DAYS} days old. Run \`claude-meter pricing --scan\`.`);
    }
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

  // Log retention. Worth surfacing here because a short window is invisible
  // otherwise: pruned projects vanish from reports rather than showing zero.
  const retention = readRetentionSetting();
  const retentionState = scanRetentionState([...allPaths.keys()]);
  lines.push('  Log retention:');
  if (retention.parseError) {
    lines.push(`    \u2717 ${retention.path} is unreadable \u2014 ${retention.parseError}`);
  } else {
    const source = retention.isDefault ? 'Claude Code default' : 'configured';
    lines.push(`    cleanupPeriodDays  ${retention.days} days (${source})`);
  }
  if (retentionState.oldestAgeDays !== null) {
    lines.push(`    Oldest log:        ${retentionState.oldestAgeDays.toFixed(1)} days`);
  }
  if (retentionState.pruned.length > 0) {
    const sessions = retentionState.pruned.reduce((acc, p) => acc + p.sessions, 0);
    lines.push(`    \u2717 ${retentionState.pruned.length} projects already lost their logs (${sessions} sessions)`);
  }
  if (retention.isDefault) {
    lines.push(`    Reports cannot see past ${retention.days} days. Run \`claude-meter retention\` to extend.`);
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
