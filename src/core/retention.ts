import { copyFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Claude Code's own log retention, and what it costs this tool.
 *
 * Claude Code deletes `projects/<project>/<session>.jsonl` on startup once the
 * file is older than `cleanupPeriodDays` (default 30). Every hour this tool
 * reports is derived from those transcripts, so retention is a hard ceiling on
 * how far back any report can see — and the loss is silent: the project folder
 * stays behind, so a pruned project simply stops appearing rather than showing
 * zero.
 */

/** Claude Code's default when the setting is absent. Documented, not guessed. */
export const DEFAULT_CLEANUP_PERIOD_DAYS = 30;

/** Ten years — long enough that billing history outlives the projects. */
export const RECOMMENDED_CLEANUP_PERIOD_DAYS = 3650;

const DAY_MS = 86_400_000;

export interface RetentionSetting {
  path: string;
  fileExists: boolean;
  /** Effective value: the configured number, or the documented default. */
  days: number;
  /** True when nothing is configured and the default is doing the work. */
  isDefault: boolean;
  /** Set when the file exists but could not be parsed. */
  parseError: string | null;
}

export interface PrunedProject {
  /** The real project path if the tombstone records one, else the log dir name. */
  path: string;
  sessions: number;
  messages: number;
  /** ISO date of the last activity the tombstone remembers, if any. */
  lastActivity: string | null;
}

export interface RetentionState {
  sessionFiles: number;
  totalBytes: number;
  oldestAgeDays: number | null;
  newestAgeDays: number | null;
  /** Log directories that still hold at least one transcript. */
  projectsWithLogs: number;
  /** Log directories left with no transcript at all — pruned or never written. */
  projectsWithoutLogs: number;
  /** The subset of those that left a sessions-index tombstone behind. */
  pruned: PrunedProject[];
  /** Transcripts the index still references that are gone from disk. */
  missingTranscripts: number;
}

export function defaultSettingsPath(): string {
  return join(homedir(), '.claude', 'settings.json');
}

/** Reads the effective retention setting without throwing on a broken file. */
export function readRetentionSetting(settingsPath = defaultSettingsPath()): RetentionSetting {
  if (!existsSync(settingsPath)) {
    return {
      path: settingsPath,
      fileExists: false,
      days: DEFAULT_CLEANUP_PERIOD_DAYS,
      isDefault: true,
      parseError: null,
    };
  }

  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
    const raw = parsed['cleanupPeriodDays'];
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return { path: settingsPath, fileExists: true, days: raw, isDefault: false, parseError: null };
    }
    return {
      path: settingsPath,
      fileExists: true,
      days: DEFAULT_CLEANUP_PERIOD_DAYS,
      isDefault: true,
      parseError: null,
    };
  } catch (err) {
    // A settings file we cannot parse is exactly when Claude Code pauses its
    // own cleanup sweep, so report it rather than guessing a value.
    return {
      path: settingsPath,
      fileExists: true,
      days: DEFAULT_CLEANUP_PERIOD_DAYS,
      isDefault: true,
      parseError: err instanceof Error ? err.message : String(err),
    };
  }
}

interface IndexEntry {
  fullPath?: string;
  messageCount?: number;
  modified?: string;
  created?: string;
  projectPath?: string;
}

/** Surveys what survives on disk and what the tombstones say was lost. */
export function scanRetentionState(logPaths: string[], now = Date.now()): RetentionState {
  const state: RetentionState = {
    sessionFiles: 0,
    totalBytes: 0,
    oldestAgeDays: null,
    newestAgeDays: null,
    projectsWithLogs: 0,
    projectsWithoutLogs: 0,
    pruned: [],
    missingTranscripts: 0,
  };

  for (const logRoot of logPaths) {
    let dirs: string[];
    try {
      dirs = readdirSync(logRoot, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name);
    } catch {
      continue;
    }

    for (const dirName of dirs) {
      const dir = join(logRoot, dirName);
      let logs: string[] = [];
      try {
        logs = readdirSync(dir, { withFileTypes: true })
          .filter(e => e.isFile() && e.name.endsWith('.jsonl'))
          .map(e => e.name);
      } catch {
        continue;
      }

      if (logs.length > 0) {
        state.projectsWithLogs++;
        for (const name of logs) {
          try {
            const st = statSync(join(dir, name));
            state.sessionFiles++;
            state.totalBytes += st.size;
            const ageDays = (now - st.mtimeMs) / DAY_MS;
            if (state.oldestAgeDays === null || ageDays > state.oldestAgeDays) state.oldestAgeDays = ageDays;
            if (state.newestAgeDays === null || ageDays < state.newestAgeDays) state.newestAgeDays = ageDays;
          } catch {
            // A file that vanished mid-scan is not worth failing the survey over.
          }
        }
      } else {
        state.projectsWithoutLogs++;
      }

      // The tombstone: an index naming transcripts that no longer exist.
      const indexPath = join(dir, 'sessions-index.json');
      if (!existsSync(indexPath)) continue;

      let entries: IndexEntry[] = [];
      try {
        const parsed = JSON.parse(readFileSync(indexPath, 'utf-8')) as { entries?: IndexEntry[] };
        entries = parsed.entries ?? [];
      } catch {
        continue;
      }

      const gone = entries.filter(e => e.fullPath && !existsSync(e.fullPath));
      state.missingTranscripts += gone.length;

      if (gone.length > 0 && logs.length === 0) {
        const times = gone
          .map(e => e.modified ?? e.created)
          .filter((t): t is string => Boolean(t))
          .map(t => new Date(t).getTime())
          .filter(t => Number.isFinite(t));

        state.pruned.push({
          path: gone.find(e => e.projectPath)?.projectPath ?? dirName,
          sessions: gone.length,
          messages: gone.reduce((acc, e) => acc + (e.messageCount ?? 0), 0),
          lastActivity: times.length
            ? new Date(Math.max(...times)).toISOString().slice(0, 10)
            : null,
        });
      }
    }
  }

  state.pruned.sort((a, b) => b.messages - a.messages);
  return state;
}

/**
 * Projects disk use at a longer retention, from the current bytes-per-day.
 *
 * Deliberately an estimate: it assumes future work resembles the window that
 * survives. Presented as "roughly" wherever it is shown.
 */
export function projectDiskUsage(state: RetentionState, targetDays: number): {
  currentBytes: number;
  perDayBytes: number;
  projectedBytes: number;
} {
  const covered = state.oldestAgeDays !== null && state.oldestAgeDays > 0 ? state.oldestAgeDays : 1;
  const perDayBytes = state.totalBytes / covered;
  return {
    currentBytes: state.totalBytes,
    perDayBytes,
    projectedBytes: perDayBytes * targetDays,
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export type ApplyOutcome =
  | { ok: true; changed: false; reason: 'already-set'; days: number }
  | { ok: true; changed: true; previous: number | null; days: number; backupPath: string }
  | { ok: false; reason: string };

/**
 * Writes `cleanupPeriodDays` into the settings file.
 *
 * Edits the file as text rather than re-serialising it: this is the user's
 * hand-maintained global config, and reformatting every line to change one
 * number is a bad trade. The result is parsed and compared key-by-key before
 * it is written, so a failed edit leaves the original untouched.
 */
export function applyRetentionSetting(
  days: number,
  settingsPath = defaultSettingsPath(),
): ApplyOutcome {
  if (!Number.isInteger(days) || days < 1) {
    return { ok: false, reason: `cleanupPeriodDays must be a whole number of days, got ${days}` };
  }
  if (!existsSync(settingsPath)) {
    return { ok: false, reason: `no settings file at ${settingsPath}` };
  }

  const original = readFileSync(settingsPath, 'utf-8');

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(original) as Record<string, unknown>;
  } catch (err) {
    return {
      ok: false,
      reason: `${settingsPath} is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    };
  }

  const previousRaw = parsed['cleanupPeriodDays'];
  const previous = typeof previousRaw === 'number' ? previousRaw : null;
  if (previous === days) {
    return { ok: true, changed: false, reason: 'already-set', days };
  }

  let updated: string;
  if (previous === null) {
    const indent = (original.match(/\n(\s+)"/) ?? [, '  '])[1];
    updated = original.replace(/^(\s*\{)/, `$1\n${indent}"cleanupPeriodDays": ${days},`);
  } else {
    updated = original.replace(/"cleanupPeriodDays"\s*:\s*-?\d+/, `"cleanupPeriodDays": ${days}`);
  }

  if (updated === original) {
    return { ok: false, reason: 'the edit produced no change; settings left untouched' };
  }

  let check: Record<string, unknown>;
  try {
    check = JSON.parse(updated) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: 'the edit produced invalid JSON; settings left untouched' };
  }

  if (check['cleanupPeriodDays'] !== days) {
    return { ok: false, reason: 'the edited file does not carry the new value; settings left untouched' };
  }

  // Nothing else in the file may move.
  const others = Object.keys(parsed).filter(k => k !== 'cleanupPeriodDays');
  const othersAfter = Object.keys(check).filter(k => k !== 'cleanupPeriodDays');
  const preserved =
    others.length === othersAfter.length &&
    others.every(k => othersAfter.includes(k)) &&
    others.every(k => JSON.stringify(parsed[k]) === JSON.stringify(check[k]));

  if (!preserved) {
    return { ok: false, reason: 'other settings would have changed; settings left untouched' };
  }

  const backupPath = `${settingsPath}.bak`;
  copyFileSync(settingsPath, backupPath);
  writeFileSync(settingsPath, updated, 'utf-8');

  return { ok: true, changed: true, previous, days, backupPath };
}
