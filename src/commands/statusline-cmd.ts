import { execSync } from 'node:child_process';
import { basename, join } from 'node:path';
import { CacheManager } from '../core/cache-manager.js';
import { ConfigManager } from '../core/config-manager.js';
import { discoverLogPaths, findJsonlFiles } from '../core/path-resolver.js';
import { scanFile } from '../core/scanner.js';
import { Aggregator } from '../core/aggregator.js';
import { calculateCosts } from '../core/cost-calculator.js';
import { getDateRange } from '../core/date-ranges.js';
import { formatTokens, formatCost } from '../core/formatter.js';
import { homedir } from 'node:os';

export type StatuslineMode = 'replace' | 'add' | 'inline';

export interface StatuslineOptions {
  noColor?: boolean;
  /**
   * Where the token cache lives. Defaults to the real `~/.claude-meter`.
   *
   * Overridable so a caller can point at its own directory instead of the
   * invoking user's home — without it, rendering always reads (and on a stale
   * cache, writes) the machine's real state, which makes the output depend on
   * whatever happened to be cached at the time.
   */
  cacheDir?: string;
  /**
   * Whether a stale cache may trigger a rescan mid-render. Defaults to true.
   *
   * Set false when the caller needs the render to depend only on what is
   * already cached: the refresh walks every session log, so leaving it on makes
   * the call both slow and dependent on unrelated on-disk state.
   */
  autoRefresh?: boolean;
}

interface StdinData {
  model?: { id?: string; display_name?: string };
  context_window?: {
    current_usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    } | null;
    context_window_size?: number;
    used_percentage?: number;
  };
  workspace?: { current_dir?: string };
  cost?: { total_cost_usd?: number };
  rate_limits?: {
    five_hour?: { used_percentage?: number; utilization?: number; resets_at?: number };
    seven_day?: { used_percentage?: number; utilization?: number; resets_at?: number };
  };
}

function getGitBranch(cwd?: string): string | null {
  try {
    const result = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: cwd || undefined,
      timeout: 2000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result.trim() || null;
  } catch {
    return null;
  }
}

function buildProgressBar(percentage: number, width = 20): string {
  const filled = Math.round((percentage / 100) * width);
  const empty = width - filled;
  return '[' + '='.repeat(filled) + ' '.repeat(empty) + ']';
}

export function buildBlockBar(percentage: number, width = 8): string {
  const filled = Math.round((percentage / 100) * width);
  const empty = width - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

export function formatTimeRemaining(
  resetsAtEpoch: number,
  window: '5h' | '7d',
  nowMs: number = Date.now(),
): string | null {
  const msRemaining = resetsAtEpoch * 1000 - nowMs;
  if (msRemaining <= 0) return null;

  const totalMinutes = Math.floor(msRemaining / (1000 * 60));

  if (window === '5h') {
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${hours}h ${minutes}m / 5h`;
  }

  // 7d window
  const totalHours = Math.floor(totalMinutes / 60);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return `${days}d ${hours}h / 7d`;
}

function formatTokensCompact(n: number): string {
  if (n === 0) return '0';
  if (n < 1000) return String(n);
  return `${Math.round(n / 1000)}k`;
}

async function refreshCache(cacheManager: CacheManager, configManager: ConfigManager): Promise<void> {
  const config = configManager.load();
  const logPaths = config.logPaths.length > 0 ? config.logPaths : discoverLogPaths();
  if (logPaths.length === 0) return;

  const now = new Date();
  const todayRange = getDateRange('today', now);
  const monthRange = getDateRange('this-month', now);

  const todayAgg = new Aggregator();
  const monthAgg = new Aggregator();

  for (const logPath of logPaths) {
    const files = findJsonlFiles(logPath);
    for (const file of files) {
      await scanFile(file, (entry) => {
        // Add to month aggregator (wider range)
        if (entry.timestamp >= monthRange.start && entry.timestamp <= monthRange.end) {
          monthAgg.add(entry);
        }
        // Add to today aggregator (narrower range)
        if (entry.timestamp >= todayRange.start && entry.timestamp <= todayRange.end) {
          todayAgg.add(entry);
        }
      });
    }
  }

  const todayResult = todayAgg.getResult('today', todayRange.start, todayRange.end);
  const monthResult = monthAgg.getResult('this-month', monthRange.start, monthRange.end);
  const todayCost = calculateCosts(todayResult);
  const monthCost = calculateCosts(monthResult);

  cacheManager.write({
    today: { tokens: todayResult.totals.fresh_total, cost: todayCost.total },
    month: { tokens: monthResult.totals.fresh_total, cost: monthCost.total },
  });
}

function costColor(amount: number, noColor?: boolean): string {
  if (noColor) return '';
  if (amount >= 500) return '\x1b[91m';  // red
  if (amount >= 100) return '\x1b[93m';  // yellow
  return '\x1b[92m';                      // green
}

function getHistoricalLine(cacheManager: CacheManager, noColor?: boolean): string {
  const entry = cacheManager.read();
  if (!entry || !entry.data) {
    return '...';
  }

  const DIM = noColor ? '' : '\x1b[2m';
  const CYAN = noColor ? '' : '\x1b[96m';
  const RESET = noColor ? '' : '\x1b[0m';

  const data = entry.data as Record<string, unknown>;
  const parts: string[] = [];

  const today = data.today as { tokens?: number; cost?: number } | undefined;
  const month = data.month as { tokens?: number; cost?: number } | undefined;

  if (today) {
    const cc = costColor(today.cost ?? 0, noColor);
    parts.push(`${DIM}Today:${RESET} ${CYAN}${formatTokens(today.tokens ?? 0)}${RESET} ${DIM}~${RESET}${cc}${formatCost(today.cost ?? 0)}${RESET}`);
  }
  if (month) {
    const cc = costColor(month.cost ?? 0, noColor);
    parts.push(`${DIM}Month:${RESET} ${CYAN}${formatTokens(month.tokens ?? 0)}${RESET} ${DIM}~${RESET}${cc}${formatCost(month.cost ?? 0)}${RESET}`);
  }

  if (parts.length === 0) {
    return '...';
  }

  return parts.join(` ${DIM}|${RESET} `);
}

function buildRateLimitLine(
  rateLimits: NonNullable<StdinData['rate_limits']>,
  noColor?: boolean,
): string | null {
  const GREEN = noColor ? '' : '\x1b[92m';
  const YELLOW = noColor ? '' : '\x1b[93m';
  const RED = noColor ? '' : '\x1b[91m';
  const DIM = noColor ? '' : '\x1b[37m';
  const RESET = noColor ? '' : '\x1b[0m';

  const parts: string[] = [];

  const windows: Array<{
    data: { used_percentage?: number; utilization?: number; resets_at?: number } | undefined;
    label: '5h' | '7d';
  }> = [
    { data: rateLimits.five_hour, label: '5h' },
    { data: rateLimits.seven_day, label: '7d' },
  ];

  for (const { data, label } of windows) {
    if (!data) continue;
    const pct = data.used_percentage ?? data.utilization;
    if (pct == null) continue;
    let barColor = GREEN;
    if (pct >= 80) barColor = RED;
    else if (pct >= 50) barColor = YELLOW;

    const bar = buildBlockBar(pct, 8);
    let timePart = '';
    if (data.resets_at != null) {
      const timeStr = formatTimeRemaining(data.resets_at, label);
      if (timeStr) {
        timePart = ` (${timeStr})`;
      }
    }

    parts.push(`${barColor}${bar}${RESET} ${pct}%${timePart}`);
  }

  if (parts.length === 0) return null;
  return `${DIM}Usage${RESET} ${parts.join(` ${DIM}|${RESET} `)}`;
}

export async function renderStatusline(
  stdinData: StdinData,
  mode: StatuslineMode,
  options?: StatuslineOptions,
): Promise<string> {
  const cacheDir = options?.cacheDir ?? join(homedir(), '.claude-meter');
  const cacheManager = new CacheManager(cacheDir);
  const configManager = new ConfigManager();

  // Auto-refresh cache if stale or missing
  if (options?.autoRefresh !== false) {
    const ttl = configManager.load().statusline.refreshCache;
    if (cacheManager.isStale(ttl)) {
      try {
        await refreshCache(cacheManager, configManager);
      } catch {
        // Don't block statusline on scan errors
      }
    }
  }

  const modelName = stdinData.model?.display_name ?? stdinData.model?.id ?? 'Unknown';
  const ctxWindow = stdinData.context_window;
  const usage = ctxWindow?.current_usage;
  const percentage = ctxWindow?.used_percentage ?? 0;
  const windowSize = ctxWindow?.context_window_size ?? 0;

  // Calculate used tokens
  const inputTokens = usage?.input_tokens ?? 0;
  const outputTokens = usage?.output_tokens ?? 0;
  const cacheRead = usage?.cache_read_input_tokens ?? 0;
  const cacheCreation = usage?.cache_creation_input_tokens ?? 0;
  const usedTokens = inputTokens + outputTokens + cacheRead + cacheCreation;

  const sessionCost = stdinData.cost?.total_cost_usd ?? 0;
  const projectDir = stdinData.workspace?.current_dir ?? '';
  const projectName = projectDir ? basename(projectDir) : '';

  // ANSI color codes (matching original Python statusline)
  const CYAN = options?.noColor ? '' : '\x1b[96m';
  const GREEN = options?.noColor ? '' : '\x1b[92m';
  const YELLOW = options?.noColor ? '' : '\x1b[93m';
  const WHITE = options?.noColor ? '' : '\x1b[97m';
  const MAGENTA = options?.noColor ? '' : '\x1b[95m';
  const BLUE = options?.noColor ? '' : '\x1b[94m';
  const DIM = options?.noColor ? '' : '\x1b[37m';
  const RESET = options?.noColor ? '' : '\x1b[0m';

  // Progress bar color based on percentage
  let barColor = GREEN;
  if (percentage >= 80) barColor = options?.noColor ? '' : '\x1b[91m'; // red
  else if (percentage >= 50) barColor = YELLOW;

  if (mode === 'replace') {
    // Line 1: model + progress bar + tokens + git + project
    const bar = buildProgressBar(percentage);
    const tokensStr = `${formatTokensCompact(usedTokens)}/${formatTokensCompact(windowSize)}`;

    const gitBranch = getGitBranch(projectDir || undefined);
    const gitPart = gitBranch ? ` ${MAGENTA}git:${gitBranch}${RESET}` : '';
    const projectPart = projectName ? ` | ${BLUE}${projectName}${RESET}` : '';

    const line1 = `${CYAN}${modelName}${RESET} ${barColor}${bar}${RESET} ${YELLOW}${percentage}%${RESET} ${WHITE}${tokensStr}${RESET}${gitPart}${projectPart}`;

    // Line 2: historical meter data (colors built-in)
    const line2 = getHistoricalLine(cacheManager, options?.noColor);

    // Line 3: rate limit usage (optional)
    const rateLimitLine = stdinData.rate_limits
      ? buildRateLimitLine(stdinData.rate_limits, options?.noColor)
      : null;

    if (rateLimitLine) {
      return `${line1}\n${line2}\n${rateLimitLine}\n`;
    }
    return `${line1}\n${line2}\n`;
  }

  if (mode === 'add') {
    // Single line: historical meter data or session cost
    const historicalLine = getHistoricalLine(cacheManager, options?.noColor);
    return `${historicalLine}\n`;
  }

  // inline mode: compact single line
  const historicalLine = getHistoricalLine(cacheManager, options?.noColor);
  // Always include session cost in inline
  const costPart = `$${sessionCost.toFixed(2)}`;
  const cacheEntry = cacheManager.read();
  if (cacheEntry?.data) {
    return `${historicalLine} | Session: ${costPart}\n`;
  }
  return `Session: ${costPart}\n`;
}
