import { existsSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, writeSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { dayIsUnfinished } from './day-archive.js';
import { PackedTokens } from './token-cache.js';

/** On-disk format. Bump only when the record shape changes. */
const ARCHIVE_VERSION = 1;

const ARCHIVE_FILE = 'token-archive.ndjson';

/**
 * The version of the *attribution rules* an entry was computed under.
 *
 * Separate from ARCHIVE_VERSION, which is about the file. This one moves
 * whenever what counts toward a project changes, so entries computed under an
 * older rule can be recognised and recomputed while the logs still exist.
 *
 * 1 — turn usage from top-level session logs and subagent transcripts,
 *     attributed to the project by the `cwd` on each usage-bearing line.
 */
export const TOKEN_ALGO_VERSION = 1;

/** One project's token usage on one local day. */
export interface ArchivedTokenDay {
  /** Local YYYY-MM-DD. Local, because a day is what your calendar says. */
  day: string;
  /** The project's resolved path — the same id the reports use. */
  project: string;
  /** Display name at the time it was archived, for projects whose logs are gone. */
  name: string;
  /**
   * Raw counters per model, never a cost.
   *
   * Cost is deliberately not stored. Rates change, and the bundled table is
   * corrected between releases; an archived dollar figure would freeze a day at
   * whatever the table said the first time it was seen, and a later price fix
   * would silently apply to recent days but not old ones. Keeping the tokens
   * means every day is priced by the same table on every render.
   */
  models: Record<string, PackedTokens>;
  sessionCount: number;
  /** The attribution rules used — see TOKEN_ALGO_VERSION. */
  algo: number;
}

export type ArchiveSaveResult = { ok: true; written: number } | { ok: false; reason: string };

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A durable record of finished days' token usage.
 *
 * The same problem the day archive solves, for spend rather than time: Claude
 * Code deletes session transcripts once they pass `cleanupPeriodDays`, and the
 * token cache is keyed on the file, so when a log is deleted its entry is
 * pruned and that day's cost disappears from history. Once a day is over its
 * usage cannot change, so it is recorded and kept.
 *
 * Kept in its own file rather than added to the day archive's records. The two
 * have separate version gates, and folding them together would mean a change to
 * token attribution invalidated a year of carefully preserved *hours*.
 */
export class TokenArchive {
  private readonly dir: string;
  private readonly path: string;
  /** `${day} ${project}` -> entry. */
  private entries = new Map<string, ArchivedTokenDay>();
  private pending = new Set<string>();
  private recordsOnDisk = 0;

  constructor(dataDir: string) {
    this.dir = dataDir;
    this.path = join(dataDir, ARCHIVE_FILE);
  }

  private static key(day: string, project: string): string {
    return `${day} ${project}`;
  }

  load(): void {
    if (!existsSync(this.path)) return;

    try {
      let header = false;
      let count = 0;

      for (const line of readFileSync(this.path, 'utf-8').split('\n')) {
        if (!line) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          // A torn final line from an interrupted append. Everything before it
          // is intact, so keep what was already read.
          continue;
        }

        if (!header) {
          if ((parsed as { v?: number }).v !== ARCHIVE_VERSION) return;
          header = true;
          continue;
        }

        const record = parsed as ArchivedTokenDay;
        if (!record || typeof record.day !== 'string' || typeof record.project !== 'string') continue;
        if (!record.models) continue;
        // Later lines supersede earlier ones for the same day and project.
        this.entries.set(TokenArchive.key(record.day, record.project), record);
        count++;
      }

      if (!header) this.entries.clear();
      else this.recordsOnDisk = count;
    } catch {
      // An unreadable archive must not break the report. It rebuilds from logs
      // for whatever is still on disk.
      this.entries.clear();
    }
  }

  /**
   * Records a finished day.
   *
   * Today is refused: it is still being written to, and an entry claiming
   * otherwise would freeze the current day's usage at whatever it was when the
   * page was first loaded.
   */
  put(entry: ArchivedTokenDay, now: number = Date.now()): boolean {
    if (dayIsUnfinished(entry.day, now)) return false;

    const key = TokenArchive.key(entry.day, entry.project);
    const existing = this.entries.get(key);
    if (existing && sameNumbers(existing, entry)) return false;

    this.entries.set(key, entry);
    this.pending.add(key);
    return true;
  }

  /** Every archived entry for days in [startDay, endDay], inclusive. */
  range(startDay: string, endDay: string): ArchivedTokenDay[] {
    const out: ArchivedTokenDay[] = [];
    for (const entry of this.entries.values()) {
      if (entry.day >= startDay && entry.day <= endDay) out.push(entry);
    }
    return out;
  }

  get(day: string, project: string): ArchivedTokenDay | null {
    return this.entries.get(TokenArchive.key(day, project)) ?? null;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Days present in the archive, ascending. */
  days(): string[] {
    return [...new Set([...this.entries.values()].map(e => e.day))].sort();
  }

  /**
   * Removes temp files an interrupted rewrite left behind.
   *
   * Scoped to this file's own naming so it can never touch the day archive's or
   * either cache's temp files sitting in the same directory.
   */
  sweepTempFiles(): number {
    let removed = 0;
    try {
      for (const name of readdirSync(this.dir)) {
        if (!/^token-archive-[0-9a-f]{8}\.tmp$/.test(name)) continue;
        try {
          unlinkSync(join(this.dir, name));
          removed++;
        } catch {
          // Locked or already gone; nothing to do.
        }
      }
    } catch {
      // No data dir yet.
    }
    return removed;
  }

  /**
   * Persists new entries. Never throws — this is a record, but a failed write
   * must not take down the request that triggered it.
   */
  save(): ArchiveSaveResult {
    if (this.pending.size === 0) return { ok: true, written: 0 };

    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    } catch (err) {
      return { ok: false, reason: describe(err) };
    }

    const shouldCompact = !existsSync(this.path) || this.recordsOnDisk > this.entries.size * 2;
    return shouldCompact ? this.rewrite() : this.append();
  }

  private append(): ArchiveSaveResult {
    let fd: number | null = null;
    try {
      fd = openSync(this.path, 'a');
      let written = 0;
      for (const key of this.pending) {
        const entry = this.entries.get(key);
        if (!entry) continue;
        writeSync(fd, JSON.stringify(entry) + '\n');
        written++;
      }
      this.recordsOnDisk += written;
      this.pending.clear();
      return { ok: true, written };
    } catch (err) {
      return { ok: false, reason: describe(err) };
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // Already closed or the handle is gone; nothing to do.
        }
      }
    }
  }

  private rewrite(): ArchiveSaveResult {
    const tmp = join(this.dir, `token-archive-${randomBytes(4).toString('hex')}.tmp`);
    let fd: number | null = null;

    try {
      fd = openSync(tmp, 'w');
      writeSync(fd, JSON.stringify({ v: ARCHIVE_VERSION }) + '\n');
      // One record at a time: peak memory stays at one record however much
      // history has accumulated.
      for (const entry of this.entries.values()) {
        writeSync(fd, JSON.stringify(entry) + '\n');
      }
      closeSync(fd);
      fd = null;

      renameSync(tmp, this.path);
      this.recordsOnDisk = this.entries.size;
      const written = this.pending.size;
      this.pending.clear();
      return { ok: true, written };
    } catch (err) {
      return { ok: false, reason: describe(err) };
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // Nothing useful left to do with a handle we cannot close.
        }
      }
      if (existsSync(tmp)) {
        try {
          unlinkSync(tmp);
        } catch {
          // Left behind on a locked filesystem; harmless, swept on next load.
        }
      }
    }
  }
}

/** Total entries across every model, used for the erosion check. */
export function countEntries(models: Record<string, PackedTokens>): number {
  let total = 0;
  for (const packed of Object.values(models)) total += packed[8];
  return total;
}

/**
 * True when writing `fresh` over `existing` would lose recorded usage.
 *
 * Claude Code deletes transcripts one session at a time, so a day at the edge
 * of the retention window recomputes smaller and smaller as its sessions
 * disappear. Without this the archive would faithfully record that decay and
 * the history it exists to protect would drain away silently.
 *
 * Only a like-for-like comparison counts: a change to the attribution rules is
 * a legitimate reason for the number to move in either direction.
 */
export function wouldErodeTokens(
  existing: ArchivedTokenDay | null,
  fresh: ArchivedTokenDay,
): boolean {
  if (!existing) return false;
  if (existing.algo !== fresh.algo) return false;
  return countEntries(fresh.models) < countEntries(existing.models);
}

function sameNumbers(a: ArchivedTokenDay, b: ArchivedTokenDay): boolean {
  if (a.sessionCount !== b.sessionCount || a.algo !== b.algo) return false;

  const aModels = Object.keys(a.models);
  const bModels = Object.keys(b.models);
  if (aModels.length !== bModels.length) return false;

  for (const model of aModels) {
    const x = a.models[model];
    const y = b.models[model];
    if (!y || x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) {
      if (x[i] !== y[i]) return false;
    }
  }
  return true;
}
