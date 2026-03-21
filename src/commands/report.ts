import { ConfigManager } from '../core/config-manager.js';
import { discoverLogPaths, findJsonlFiles } from '../core/path-resolver.js';
import { scanFile } from '../core/scanner.js';
import { Aggregator } from '../core/aggregator.js';
import { calculateCosts } from '../core/cost-calculator.js';
import { getDateRange, DateRangeLabel } from '../core/date-ranges.js';
import { renderFullReport, renderCompactReport, renderJsonReport } from '../core/renderer.js';

export interface ReportFlags {
  json?: boolean;
  fresh?: boolean;
  compact?: boolean;
  noColor?: boolean;
  verbose?: boolean;
}

export async function runReport(
  command: string,
  flags: ReportFlags,
  rangeStart?: string,
  rangeEnd?: string,
): Promise<string> {
  // 1. Load config
  const configManager = new ConfigManager();
  const config = configManager.load();

  // 2. Resolve log paths (config > auto-discover)
  let logPaths = config.logPaths.length > 0 ? config.logPaths : discoverLogPaths();

  // 3. If no paths found, return helpful error
  if (logPaths.length === 0) {
    return [
      'No Claude Code log directories found.',
      '',
      'Claude Meter looks for logs in:',
      '  - ~/.claude/projects/',
      '  - Platform-specific Claude Code data directories',
      '',
      'If your logs are in a custom location, run:',
      '  claude-meter config set logPaths \'["/path/to/logs"]\'',
    ].join('\n');
  }

  // 4. Save discovered paths to config if they came from auto-discovery
  if (config.logPaths.length === 0) {
    configManager.set('logPaths', logPaths);
  }

  // 5. Get date range
  const { start, end, label } = getDateRange(command as DateRangeLabel, new Date(), rangeStart, rangeEnd);

  // 6. Find all .jsonl files across all paths
  const allFiles: string[] = [];
  for (const logPath of logPaths) {
    allFiles.push(...findJsonlFiles(logPath));
  }

  if (allFiles.length === 0) {
    return 'No .jsonl log files found in the configured paths.';
  }

  // 7. Scan all files, aggregate entries
  const aggregator = new Aggregator();
  const dateFilter = { start, end };

  for (const file of allFiles) {
    await scanFile(file, (entry) => aggregator.add(entry), dateFilter);
  }

  aggregator.setFilesScanned(allFiles.length);
  const aggResult = aggregator.getResult(label, start, end);

  // 8. Calculate costs
  const costResult = calculateCosts(aggResult, config.pricing.overrides as any);

  // 9. Render output based on flags
  if (flags.json) {
    return renderJsonReport(aggResult, costResult);
  }

  if (flags.compact) {
    return renderCompactReport(aggResult, costResult, {
      noColor: flags.noColor,
      verbose: flags.verbose,
    });
  }

  return renderFullReport(aggResult, costResult, {
    noColor: flags.noColor,
    verbose: flags.verbose,
  });
}
