import { AggregationResult } from './aggregator.js';
import { CostResult } from './cost-calculator.js';
import { formatTokens, formatCost, formatPercentage } from './formatter.js';
import { assessPricingStaleness, isPlaceholderModel } from './pricing.js';

export interface RenderOptions {
  noColor?: boolean;
  verbose?: boolean;
  skippedLines?: number;
}

type ChalkFn = (s: string) => string;
interface ChalkLike {
  bold: ChalkLike & ChalkFn;
  dim: ChalkLike & ChalkFn;
  cyan: ChalkLike & ChalkFn;
  green: ChalkLike & ChalkFn;
  yellow: ChalkLike & ChalkFn;
  white: ChalkLike & ChalkFn;
  gray: ChalkLike & ChalkFn;
  (s: string): string;
}

function noColorChalk(): ChalkLike {
  const passthrough = (s: string) => s;
  const handler: ProxyHandler<any> = {
    get(_target: any, _prop: string | symbol): any {
      return new Proxy(passthrough, handler);
    },
    apply(_target: any, _thisArg: any, args: any[]): any {
      return String(args[0] ?? '');
    },
  };
  return new Proxy(passthrough, handler) as unknown as ChalkLike;
}

let _chalk: ChalkLike | null = null;

async function loadChalk(): Promise<ChalkLike> {
  if (_chalk) return _chalk;
  try {
    const mod = await import('chalk');
    _chalk = mod.default as unknown as ChalkLike;
    return _chalk;
  } catch {
    _chalk = noColorChalk();
    return _chalk;
  }
}

function getChalk(options?: RenderOptions): ChalkLike {
  if (options?.noColor) return noColorChalk();
  // For sync usage, return cached chalk or noColor fallback
  return _chalk ?? noColorChalk();
}

const BOX_WIDTH = 62;

function hLine(ch: string, width: number): string {
  return ch.repeat(width);
}

function boxTop(): string {
  return `╔${hLine('═', BOX_WIDTH)}╗`;
}

function boxBottom(): string {
  return `╚${hLine('═', BOX_WIDTH)}╝`;
}

function boxRow(content: string): string {
  const stripped = stripAnsi(content);
  const pad = BOX_WIDTH - stripped.length;
  return `║${content}${' '.repeat(Math.max(0, pad))}║`;
}

function sectionTop(title: string): string {
  const dash = hLine('─', BOX_WIDTH - title.length - 2);
  return `┌─ ${title} ${dash}┐`;
}

function sectionBottom(): string {
  return `└${hLine('─', BOX_WIDTH)}┘`;
}

function sectionRow(content: string): string {
  const stripped = stripAnsi(content);
  const pad = BOX_WIDTH - stripped.length;
  return `│${content}${' '.repeat(Math.max(0, pad))}│`;
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

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatPeriodTitle(label: string, start: string, _end: string): string {
  const d = new Date(start);
  if (label === 'this-month' || label === 'last-month') {
    return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  }
  if (label === 'today' || label === 'yesterday') {
    const ed = new Date(_end);
    return `${label.charAt(0).toUpperCase() + label.slice(1)} (${SHORT_MONTHS[ed.getUTCMonth()]} ${ed.getUTCDate()}, ${ed.getUTCFullYear()})`;
  }
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function formatDateRange(start: string, end: string): string {
  const s = new Date(start);
  const e = new Date(end);
  const sMonth = SHORT_MONTHS[s.getUTCMonth()];
  const eMonth = SHORT_MONTHS[e.getUTCMonth()];
  if (sMonth === eMonth && s.getUTCFullYear() === e.getUTCFullYear()) {
    return `${sMonth} ${s.getUTCDate()} \u2013 ${eMonth} ${e.getUTCDate()}, ${e.getUTCFullYear()}`;
  }
  return `${sMonth} ${s.getUTCDate()}, ${s.getUTCFullYear()} \u2013 ${eMonth} ${e.getUTCDate()}, ${e.getUTCFullYear()}`;
}

function buildProgressBar(percentage: number, width = 20): string {
  const filled = Math.round((percentage / 100) * width);
  return '\u2588'.repeat(filled) + '\u2591'.repeat(width - filled);
}

function modelShortName(model: string): string {
  return model
    .replace('claude-', '')
    .replace(/-\d{8}$/, '');
}

/**
 * A guessed price must never look like a real one. Any model the bundled table
 * could not price is reported explicitly, alongside a staleness note once the
 * bundle is old enough that new models are the likely explanation.
 */
function pricingWarnings(cost: CostResult): string[] {
  const lines: string[] = [];

  const guessed = Object.entries(cost.by_model)
    .filter(([, mc]) => mc.fallback)
    .map(([model]) => modelShortName(model));

  if (guessed.length > 0) {
    lines.push(`  * ${guessed.join(', ')} not in the bundled table — priced at flagship rates (a guess).`);
  }

  const staleness = assessPricingStaleness();
  if (staleness.overdue.length > 0) {
    for (const change of staleness.overdue) {
      lines.push(`  ! ${modelShortName(change.model)} rates changed on ${change.effective} and this build predates it.`);
    }
  } else if (guessed.length > 0 || staleness.stale) {
    lines.push(`  Bundled pricing is ${staleness.ageDays} days old. Run \`claude-meter pricing\` for details.`);
  }

  return lines;
}

function computeModelPercentages(agg: AggregationResult): Record<string, number> {
  const total = agg.totals.entries_matched;
  const result: Record<string, number> = {};
  for (const [model, data] of Object.entries(agg.by_model)) {
    // Placeholders like <synthetic> are Claude Code's own turns, always zero
    // tokens. Listing them as a "model" alongside opus and sonnet is noise.
    if (isPlaceholderModel(model)) continue;
    const entries = (data as any).entries ?? (data as any).entries_matched ?? 0;
    result[model] = total > 0 ? (entries / total) * 100 : 0;
  }
  return result;
}

export function renderFullReport(
  agg: AggregationResult,
  cost: CostResult,
  options?: RenderOptions,
): string {
  const c = getChalk(options);
  const lines: string[] = [];
  const t = agg.totals;
  const title = `Claude Meter \u2014 ${formatPeriodTitle(agg.period.label, agg.period.start, agg.period.end)}`;

  // Header
  lines.push(boxTop());
  lines.push(boxRow(centerText(title, BOX_WIDTH)));
  lines.push(boxBottom());
  lines.push('');

  // Summary
  lines.push(`  Period:          ${formatDateRange(agg.period.start, agg.period.end)}`);
  lines.push(`  Files Scanned:   ${t.files_scanned.toLocaleString('en-US')}`);
  lines.push(`  Entries:         ${t.entries_matched.toLocaleString('en-US')}`);
  lines.push(`  Sessions:        ${t.sessions.toLocaleString('en-US')}`);
  lines.push('');

  // Token Usage
  lines.push(sectionTop('Token Usage'));
  lines.push(sectionRow(`  Input Tokens:          ${formatTokens(t.input_tokens)}${' '.repeat(30)}`));
  lines.push(sectionRow(`  Output Tokens:         ${formatTokens(t.output_tokens)}${' '.repeat(30)}`));
  lines.push(sectionRow(`  Fresh Total:           ${formatTokens(t.fresh_total)}${' '.repeat(30)}`));
  lines.push(sectionRow(''));
  lines.push(sectionRow(`  Cache Read:            ${formatTokens(t.cache_read_input_tokens)}${' '.repeat(30)}`));
  lines.push(sectionRow(`  Cache Created (5m):    ${formatTokens(t.cache_5m_input_tokens)}${' '.repeat(30)}`));
  lines.push(sectionRow(`  Cache Created (1h):    ${formatTokens(t.cache_1h_input_tokens)}${' '.repeat(30)}`));
  lines.push(sectionRow(`  Full Total:            ${formatTokens(t.full_total)}${' '.repeat(30)}`));
  lines.push(sectionBottom());
  lines.push('');

  // By Model
  const modelPcts = computeModelPercentages(agg);
  lines.push(sectionTop('By Model'));
  for (const [model, pct] of Object.entries(modelPcts)) {
    const pctStr = formatPercentage(pct).padStart(6);
    const bar = buildProgressBar(pct);
    const name = model.length > 30 ? model.substring(0, 30) : model;
    lines.push(sectionRow(`  ${name.padEnd(30)} ${pctStr}    ${bar}  `));
  }
  lines.push(sectionBottom());
  lines.push('');

  // Cost
  lines.push(sectionTop('Estimated Cost (USD)'));
  lines.push(sectionRow(`  Input:              ${formatCost(cost.input)}${' '.repeat(30)}`));
  lines.push(sectionRow(`  Output:             ${formatCost(cost.output)}${' '.repeat(30)}`));
  lines.push(sectionRow(`  Cache Read:         ${formatCost(cost.cache_read)}${' '.repeat(30)}`));
  lines.push(sectionRow(`  Cache Create (5m):  ${formatCost(cost.cache_creation_5m)}${' '.repeat(30)}`));
  lines.push(sectionRow(`  Cache Create (1h):  ${formatCost(cost.cache_creation_1h)}${' '.repeat(30)}`));
  lines.push(sectionRow(`${''.padStart(44)}\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500`));
  lines.push(sectionRow(`  Total:              ${formatCost(cost.total)}${' '.repeat(30)}`));
  lines.push(sectionRow(''));
  lines.push(sectionRow('  By Model:'));
  for (const [model, mc] of Object.entries(cost.by_model)) {
    if (isPlaceholderModel(model)) continue; // always $0.00; nothing to show
    const short = modelShortName(model) + (mc.fallback ? ' *' : '');
    lines.push(sectionRow(`    ${short.padEnd(18)} ${formatCost(mc.total)}${' '.repeat(24)}`));
  }
  lines.push(sectionBottom());
  lines.push('');

  // Pricing footer
  lines.push(`  Pricing: ${cost.pricing_source} defaults (${cost.pricing_version})`);
  lines.push(...pricingWarnings(cost));
  lines.push('');

  return lines.join('\n');
}

export function renderCompactReport(
  agg: AggregationResult,
  cost: CostResult,
  options?: RenderOptions,
): string {
  const t = agg.totals;
  const title = formatPeriodTitle(agg.period.label, agg.period.start, agg.period.end);
  const lines: string[] = [];

  lines.push(`Claude Meter \u2014 ${title}`);
  lines.push('');
  lines.push(`  Entries: ${t.entries_matched.toLocaleString('en-US')} | Sessions: ${t.sessions.toLocaleString('en-US')}`);
  lines.push('');
  lines.push(`  Tokens:   Input ${formatTokens(t.input_tokens)} | Output ${formatTokens(t.output_tokens)} | Fresh ${formatTokens(t.fresh_total)}`);
  lines.push(`  Cache:    Read ${formatTokens(t.cache_read_input_tokens)} | 5m ${formatTokens(t.cache_5m_input_tokens)} | 1h ${formatTokens(t.cache_1h_input_tokens)} | Full ${formatTokens(t.full_total)}`);
  lines.push('');

  // Models
  const modelPcts = computeModelPercentages(agg);
  const modelParts = Object.entries(modelPcts)
    .map(([m, p]) => `${modelShortName(m)} ${Math.round(p)}%`)
    .join(' | ');
  lines.push(`  Models:   ${modelParts}`);
  lines.push('');

  // Cost
  const costParts = Object.entries(cost.by_model)
    .filter(([m]) => !isPlaceholderModel(m))
    .map(([m, mc]) => `${modelShortName(m).split('-')[0]} ${formatCost(mc.total)}`)
    .join(' | ');
  lines.push(`  Cost:     ${formatCost(cost.total)} (${costParts})`);
  lines.push('');
  lines.push(`  Pricing:  ${cost.pricing_source} defaults`);
  lines.push(...pricingWarnings(cost));
  lines.push('');

  return lines.join('\n');
}

export function renderJsonReport(
  agg: AggregationResult,
  cost: CostResult,
): string {
  const output = {
    period: agg.period,
    totals: agg.totals,
    by_model: agg.by_model,
    cost_estimate_usd: {
      input: cost.input,
      output: cost.output,
      cache_read: cost.cache_read,
      cache_creation_5m: cost.cache_creation_5m,
      cache_creation_1h: cost.cache_creation_1h,
      total: cost.total,
      by_model: cost.by_model,
    },
    pricing: {
      source: cost.pricing_source,
      version: cost.pricing_version,
    },
  };
  return JSON.stringify(output, null, 2);
}
