import { runReport } from './report.js';
import { formatTokens, formatCost } from '../core/formatter.js';

export interface WatchOptions {
  interval?: number;  // seconds, default 30
  compact?: boolean;
  json?: boolean;
  noColor?: boolean;
}

interface PeriodSummary {
  label: string;
  entries: number;
  freshTotal: number;
  totalCost: number;
}

async function fetchPeriodSummary(command: string, label: string): Promise<PeriodSummary> {
  try {
    const jsonStr = await runReport(command, { json: true });
    const data = JSON.parse(jsonStr);
    return {
      label,
      entries: data.totals?.entries_matched ?? 0,
      freshTotal: data.totals?.fresh_total ?? 0,
      totalCost: data.cost_estimate_usd?.total ?? 0,
    };
  } catch {
    return { label, entries: 0, freshTotal: 0, totalCost: 0 };
  }
}

const BOX_WIDTH = 62;

function hLine(ch: string, width: number): string {
  return ch.repeat(width);
}

function renderFullDashboard(
  periods: PeriodSummary[],
  intervalSec: number,
  secondsLeft: number,
): string {
  const lines: string[] = [];

  // Header box
  lines.push(`\u2554${hLine('\u2550', BOX_WIDTH)}\u2557`);
  lines.push(boxRow(centerText('Claude Meter \u2014 Live Monitor', BOX_WIDTH)));
  lines.push(boxRow(centerText(`Refreshing every ${intervalSec}s | Ctrl+C to exit`, BOX_WIDTH)));
  lines.push(`\u255A${hLine('\u2550', BOX_WIDTH)}\u255D`);
  lines.push('');

  // Period rows
  for (const p of periods) {
    const lbl = p.label.padEnd(14);
    const entries = `${p.entries.toLocaleString('en-US')} entries`.padEnd(17);
    const tokens = `${formatTokens(p.freshTotal)} tokens`.padEnd(16);
    const cost = formatCost(p.totalCost);
    lines.push(`  ${lbl}${entries}${tokens}${cost}`);
  }

  lines.push('');
  lines.push(`  Next refresh: ${secondsLeft}s`);
  lines.push('');

  return lines.join('\n');
}

function renderCompactDashboard(
  periods: PeriodSummary[],
  intervalSec: number,
): string {
  const lines: string[] = [];

  lines.push(`Claude Meter \u2014 Live (${intervalSec}s) | Ctrl+C to exit`);
  lines.push('');

  const parts = periods.map((p) => {
    return `${p.label}:  ${formatTokens(p.freshTotal)}  ${formatCost(p.totalCost)}`;
  });
  lines.push(`  ${parts.join('    ')}`);
  lines.push('');

  return lines.join('\n');
}

function renderJsonDashboard(periods: PeriodSummary[]): string {
  const obj: Record<string, { entries: number; fresh_tokens: number; cost_usd: number }> = {};
  for (const p of periods) {
    obj[p.label.toLowerCase().replace(/\s+/g, '_')] = {
      entries: p.entries,
      fresh_tokens: p.freshTotal,
      cost_usd: p.totalCost,
    };
  }
  return JSON.stringify({ timestamp: new Date().toISOString(), ...obj });
}

function boxRow(content: string): string {
  const stripped = stripAnsi(content);
  const pad = BOX_WIDTH - stripped.length;
  return `\u2551${content}${' '.repeat(Math.max(0, pad))}\u2551`;
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function centerText(text: string, width: number): string {
  const stripped = stripAnsi(text);
  const totalPad = width - stripped.length;
  const left = Math.floor(totalPad / 2);
  const right = totalPad - left;
  return ' '.repeat(Math.max(0, left)) + text + ' '.repeat(Math.max(0, right));
}

async function renderDashboard(opts: WatchOptions): Promise<void> {
  const intervalSec = opts.interval ?? 30;

  // Fetch all three periods in parallel
  const [today, week, month] = await Promise.all([
    fetchPeriodSummary('today', 'Today'),
    fetchPeriodSummary('this-week', 'This Week'),
    fetchPeriodSummary('this-month', 'This Month'),
  ]);

  const periods = [today, week, month];

  if (opts.json) {
    console.log(renderJsonDashboard(periods));
    return;
  }

  // Clear terminal
  process.stdout.write('\x1Bc');

  if (opts.compact) {
    console.log(renderCompactDashboard(periods, intervalSec));
  } else {
    console.log(renderFullDashboard(periods, intervalSec, intervalSec));
  }
}

export async function runWatch(opts: WatchOptions): Promise<void> {
  const interval = (opts.interval ?? 30) * 1000;

  // Initial render
  await renderDashboard(opts);

  // Set up interval
  const timer = setInterval(async () => {
    await renderDashboard(opts);
  }, interval);

  // Handle Ctrl+C
  process.on('SIGINT', () => {
    clearInterval(timer);
    console.log('\nWatch stopped.');
    process.exit(0);
  });

  // Keep process alive
  await new Promise(() => {});
}
