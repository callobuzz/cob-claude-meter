import { ConfigManager } from '../core/config-manager.js';
import { discoverLogPaths } from '../core/path-resolver.js';
import {
  DEFAULT_CLEANUP_PERIOD_DAYS,
  RECOMMENDED_CLEANUP_PERIOD_DAYS,
  applyRetentionSetting,
  defaultSettingsPath,
  formatBytes,
  projectDiskUsage,
  readRetentionSetting,
  scanRetentionState,
} from '../core/retention.js';

export interface RetentionFlags {
  days?: string;
  yes?: boolean;
  dryRun?: boolean;
  settings?: string;
  /** Injected by tests so the confirmation prompt can be driven. */
  confirm?: (question: string) => Promise<boolean>;
}

async function askInquirer(question: string): Promise<boolean> {
  const { default: inquirer } = await import('inquirer');
  const { proceed } = await inquirer.prompt([
    { type: 'confirm', name: 'proceed', message: question, default: false },
  ]);
  return Boolean(proceed);
}

/**
 * Explains Claude Code's log retention and offers to extend it.
 *
 * Always asks first. The setting lives in the user's global Claude Code config,
 * not in this tool's own data, and longer retention has a real cost: more disk,
 * and transcripts sitting in plaintext for longer. Both are stated before the
 * prompt rather than buried after it.
 */
export async function runRetentionCommand(flags: RetentionFlags = {}): Promise<string> {
  const settingsPath = flags.settings ?? defaultSettingsPath();
  const current = readRetentionSetting(settingsPath);

  const target = flags.days === undefined
    ? RECOMMENDED_CLEANUP_PERIOD_DAYS
    : Number.parseInt(flags.days, 10);

  if (!Number.isInteger(target) || target < 1) {
    return `Invalid --days value: ${flags.days}\nGive a whole number of days, e.g. --days 3650`;
  }

  const config = new ConfigManager().load();
  const logPaths = config.logPaths.length > 0 ? config.logPaths : discoverLogPaths();
  const state = scanRetentionState(logPaths);
  const disk = projectDiskUsage(state, target);

  const out: string[] = [];
  const say = (line = '') => out.push(line);

  say('Claude Code log retention');
  say('');
  say('  Claude Meter derives every hour it reports from Claude Code session');
  say('  transcripts. Claude Code deletes those transcripts on startup once they');
  say('  are older than cleanupPeriodDays, so that setting is a hard ceiling on');
  say('  how far back any report can see.');
  say('');

  say('  Current setting');
  say(`    ${settingsPath}`);
  if (current.parseError) {
    say(`    cleanupPeriodDays  unreadable — ${current.parseError}`);
  } else if (current.isDefault) {
    say(`    cleanupPeriodDays  not set, so Claude Code's default of ${DEFAULT_CLEANUP_PERIOD_DAYS} days applies`);
  } else {
    say(`    cleanupPeriodDays  ${current.days} days`);
  }
  say('');

  say('  On disk now');
  say(`    ${state.sessionFiles} session logs across ${state.projectsWithLogs} projects, ${formatBytes(state.totalBytes)}`);
  if (state.oldestAgeDays !== null) {
    say(`    oldest surviving log is ${state.oldestAgeDays.toFixed(1)} days old`);
  }
  if (state.projectsWithoutLogs > 0) {
    say(`    ${state.projectsWithoutLogs} project folders hold no transcript at all`);
  }
  if (state.missingTranscripts > 0) {
    say(`    ${state.missingTranscripts} transcripts are referenced by an index but gone from disk`);
  }
  say('');

  if (state.pruned.length > 0) {
    say('  Already lost — these cannot be recovered');
    for (const p of state.pruned.slice(0, 8)) {
      const when = p.lastActivity ? `last active ${p.lastActivity}` : 'date unknown';
      say(`    ${p.sessions} sessions, ${p.messages} messages, ${when}`);
      say(`      ${p.path}`);
    }
    if (state.pruned.length > 8) {
      say(`    ...and ${state.pruned.length - 8} more`);
    }
    say('');
  }

  if (current.days >= target && !current.isDefault) {
    say(`  Retention is already ${current.days} days, at or above the ${target} you asked for.`);
    say('  Nothing to change.');
    return out.join('\n');
  }

  say(`  Proposed change: ${current.isDefault ? `${current.days} (default)` : String(current.days)} -> ${target} days (~${(target / 365).toFixed(1)} years)`);
  say('');
  say('  What this costs you');
  say(`    Disk. Your logs currently grow about ${formatBytes(disk.perDayBytes)}/day, so ${target}`);
  say(`    days would hold roughly ${formatBytes(disk.projectedBytes)} once the window fills.`);
  say('    That is an estimate from recent activity, not a guarantee.');
  say('');
  say('    Privacy. Transcripts are plaintext and not encrypted at rest. Anything');
  say('    that passes through a tool is written to them, including file contents');
  say('    and command output — so a credential read from a .env is in there too.');
  say('    A longer window means a longer-lived copy on disk.');
  say('');
  say('  What it does not do');
  say('    Nothing already deleted comes back. This only stops the next sweep.');
  say('');

  if (flags.dryRun) {
    say('  --dry-run: no changes written.');
    return out.join('\n');
  }

  if (current.parseError) {
    say(`  Refusing to edit: ${settingsPath} is not valid JSON.`);
    say('  Fix the file by hand first — rewriting it could lose settings.');
    return out.join('\n');
  }

  const confirmed = flags.yes
    ? true
    : await (flags.confirm ?? askInquirer)(`Set cleanupPeriodDays to ${target} in ${settingsPath}?`);

  if (!confirmed) {
    say('  Cancelled. Nothing was changed.');
    return out.join('\n');
  }

  const result = applyRetentionSetting(target, settingsPath);
  if (!result.ok) {
    say(`  Failed: ${result.reason}`);
    return out.join('\n');
  }
  if (!result.changed) {
    say(`  Already set to ${result.days} days. Nothing to do.`);
    return out.join('\n');
  }

  say(`  Done. cleanupPeriodDays: ${result.previous ?? `unset (${DEFAULT_CLEANUP_PERIOD_DAYS} default)`} -> ${result.days}`);
  say(`  Backup of the previous file: ${result.backupPath}`);
  say('  Takes effect the next time Claude Code starts.');
  return out.join('\n');
}
