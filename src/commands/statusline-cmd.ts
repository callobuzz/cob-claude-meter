import { execSync } from 'node:child_process';
import { basename } from 'node:path';
import { CacheManager } from '../core/cache-manager.js';
import { formatTokens, formatCost } from '../core/formatter.js';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type StatuslineMode = 'replace' | 'add' | 'inline';

export interface StatuslineOptions {
  noColor?: boolean;
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

function formatTokensCompact(n: number): string {
  if (n === 0) return '0';
  if (n < 1000) return String(n);
  return `${Math.round(n / 1000)}k`;
}

function getHistoricalLine(cacheManager: CacheManager): string {
  const entry = cacheManager.read();
  if (!entry || !entry.data) {
    return "Run 'claude-meter today' to populate data";
  }

  const data = entry.data as Record<string, unknown>;
  const parts: string[] = [];

  // Try to extract today and month data from cache
  const today = data.today as { tokens?: number; cost?: number } | undefined;
  const month = data.month as { tokens?: number; cost?: number } | undefined;

  if (today) {
    parts.push(`Today: ${formatTokens(today.tokens ?? 0)} ~${formatCost(today.cost ?? 0)}`);
  }
  if (month) {
    parts.push(`Month: ${formatTokens(month.tokens ?? 0)} ~${formatCost(month.cost ?? 0)}`);
  }

  if (parts.length === 0) {
    return "Run 'claude-meter today' to populate data";
  }

  return parts.join(' | ');
}

export function renderStatusline(
  stdinData: StdinData,
  mode: StatuslineMode,
  options?: StatuslineOptions,
): string {
  const cacheDir = join(homedir(), '.claude-meter');
  const cacheManager = new CacheManager(cacheDir);

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

  if (mode === 'replace') {
    // Line 1: model + progress bar + tokens + git + project
    const bar = buildProgressBar(percentage);
    const tokensStr = `${formatTokensCompact(usedTokens)}/${formatTokensCompact(windowSize)}`;

    const gitBranch = getGitBranch(projectDir || undefined);
    const gitPart = gitBranch ? ` git:${gitBranch}` : '';
    const projectPart = projectName ? ` | ${projectName}` : '';

    const line1 = `${modelName} ${bar} ${percentage}% ${tokensStr}${gitPart}${projectPart}`;

    // Line 2: historical data or session cost fallback
    const historicalLine = getHistoricalLine(cacheManager);
    const line2 = historicalLine;

    return `${line1}\n${line2}\n`;
  }

  if (mode === 'add') {
    // Single line: historical meter data or session cost
    const historicalLine = getHistoricalLine(cacheManager);
    return `${historicalLine}\n`;
  }

  // inline mode: compact single line
  const historicalLine = getHistoricalLine(cacheManager);
  // Always include session cost in inline
  const costPart = `$${sessionCost.toFixed(2)}`;
  const cacheEntry = cacheManager.read();
  if (cacheEntry?.data) {
    return `${historicalLine} | Session: ${costPart}\n`;
  }
  return `Session: ${costPart}\n`;
}
