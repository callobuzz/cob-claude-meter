import {
  assessPricingStaleness,
  findUnknownModels,
  getAllModelIds,
  getPricingSource,
  getScheduledChanges,
  resolveModelPricing,
  PRICING_STALE_AFTER_DAYS,
} from '../core/pricing.js';

import { ConfigManager } from '../core/config-manager.js';
import { discoverLogPaths, findJsonlFiles } from '../core/path-resolver.js';
import { scanFile } from '../core/scanner.js';

export interface PricingFlags {
  /** Model IDs observed elsewhere (e.g. a scan) to check against the table. */
  seen?: string[];
  /** Read the logs and report any model in them the table cannot price. */
  scan?: boolean;
  json?: boolean;
  /** Injectable for tests; defaults to now. */
  now?: Date;
}

/**
 * Every model id that appears in the local logs. This is the only reliable
 * staleness signal available offline: a model we have never heard of means the
 * bundled table predates whatever the user is now running.
 */
async function collectModelIdsFromLogs(): Promise<string[]> {
  const config = new ConfigManager().load();
  const logPaths = config.logPaths.length > 0 ? config.logPaths : discoverLogPaths();

  const seen = new Set<string>();
  for (const logPath of logPaths) {
    for (const file of findJsonlFiles(logPath)) {
      await scanFile(file, (entry: { model?: string }) => {
        if (entry.model) seen.add(entry.model);
      });
    }
  }
  return [...seen];
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function money(n: number): string {
  return '$' + (Number.isInteger(n) ? n.toFixed(0) : n.toFixed(2));
}

export async function runPricingCommand(flags: PricingFlags = {}): Promise<string> {
  const staleness = assessPricingStaleness(flags.now ?? new Date());
  const models = getAllModelIds();

  const seen = flags.seen ?? (flags.scan ? await collectModelIdsFromLogs() : undefined);
  const unknown = seen ? findUnknownModels(seen) : [];

  if (flags.json) {
    return JSON.stringify(
      {
        version: staleness.version,
        source: staleness.source,
        age_days: staleness.ageDays,
        stale: staleness.stale,
        overdue: staleness.overdue,
        upcoming: staleness.upcoming,
        unknown_models_in_logs: seen ? unknown : null,
        models: Object.fromEntries(models.map(m => [m, resolveModelPricing(m)])),
      },
      null,
      2
    );
  }

  const lines: string[] = ['Bundled pricing', ''];
  lines.push(`  Version:  ${staleness.version} (${staleness.ageDays} days old)`);
  lines.push(`  Source:   ${staleness.source}`);
  lines.push(`  Models:   ${models.length}`);
  lines.push('');

  // Rate table.
  lines.push(
    '  ' +
      pad('MODEL', 20) +
      pad('INPUT', 9) +
      pad('OUTPUT', 9) +
      pad('CW 5M', 9) +
      pad('CW 1H', 9) +
      'CACHE READ'
  );
  for (const id of models) {
    const r = resolveModelPricing(id);
    lines.push(
      '  ' +
        pad(id.replace(/^claude-/, ''), 20) +
        pad(money(r.input), 9) +
        pad(money(r.output), 9) +
        pad(money(r.cache_write_5m), 9) +
        pad(money(r.cache_write_1h), 9) +
        money(r.cache_read)
    );
  }
  lines.push('');
  lines.push('  Rates are USD per million tokens.');
  lines.push('');

  // Anything the user is actually running that we cannot price.
  if (unknown.length > 0) {
    lines.push(`  ✗ ${unknown.length} model(s) in your logs are not in this table:`);
    for (const m of unknown) lines.push(`      ${m}`);
    lines.push('    Their costs are estimated at flagship rates, so they are a guess.');
    lines.push('');
  }

  // Scheduled rate changes we already know about.
  if (staleness.overdue.length > 0) {
    for (const c of staleness.overdue) {
      lines.push(`  ✗ ${c.model} changed on ${c.effective} — this build still uses the old rates.`);
      lines.push(`      ${c.reason}`);
    }
    lines.push('');
  }
  if (staleness.upcoming.length > 0) {
    for (const c of staleness.upcoming) {
      lines.push(`  ! ${c.model} rates change on ${c.effective}: input ${money(c.rates.input)}, output ${money(c.rates.output)}.`);
      lines.push(`      ${c.reason}`);
    }
    lines.push('');
  }

  // Verdict.
  if (staleness.stale) {
    lines.push(
      `  ✗ This pricing is over ${PRICING_STALE_AFTER_DAYS} days old. Anthropic ships models faster than that,`
    );
    lines.push('    so new ones are likely missing. Update with: npm i -g cob-claude-meter');
  } else if (unknown.length > 0 || staleness.overdue.length > 0) {
    lines.push('  Update with: npm i -g cob-claude-meter');
  } else {
    lines.push('  Pricing looks current ✓');
  }

  lines.push('');
  lines.push('  Costs are estimates at published API rates. On a subscription plan');
  lines.push('  they show what the same usage would have cost on the API — not a bill.');

  return lines.join('\n');
}
