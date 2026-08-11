import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename } from 'node:path';

/** A contiguous span of activity: [startMs, endMs]. */
export type Interval = [number, number];

/** Gaps longer than this are treated as idle time and dropped. */
export const DEFAULT_IDLE_SECONDS = 300;

/**
 * How a session's working time was established.
 *
 * `turns` means Claude Code recorded how long each turn took and we used those
 * numbers. `gaps` means it did not, so the time was inferred from how closely
 * log entries sit together — an estimate governed by the idle threshold.
 */
export type TimingSource = 'turns' | 'gaps';

export interface SessionScan {
  /** Every timestamp found in the session, ascending. */
  timestamps: number[];
  /** Every `cwd` value seen, with how many entries carried it. */
  cwds: Map<string, number>;
  /**
   * One interval per completed turn, from Claude Code's own `turn_duration`
   * records. These are measured, not inferred: a turn that spent 40 minutes
   * inside a single build is 40 minutes here.
   */
  turns: Interval[];
}

export interface SessionTimeline {
  sessionId: string;
  filePath: string;
  intervals: Interval[];
  activeMs: number;
  firstSeen: number | null;
  lastSeen: number | null;
  /** Whether activeMs was measured from turn records or inferred from gaps. */
  source: TimingSource;
}

/**
 * Reads a session .jsonl for wall-clock evidence.
 *
 * Unlike the token scanner this keeps *every* timestamped entry, not just
 * assistant messages with usage — user turns, system events and attachments
 * are all proof that the session was alive at that moment.
 */
export async function scanSessionTimestamps(filePath: string): Promise<SessionScan> {
  const timestamps: number[] = [];
  const cwds = new Map<string, number>();
  const turns: Interval[] = [];

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line) continue;
    // Cheap prefilter: session logs reach 100MB+ and most lines carry neither field.
    const hasTimestamp = line.indexOf('"timestamp"') !== -1;
    const hasCwd = line.indexOf('"cwd"') !== -1;
    if (!hasTimestamp && !hasCwd) continue;

    try {
      const json = JSON.parse(line);

      if (typeof json.cwd === 'string' && json.cwd) {
        cwds.set(json.cwd, (cwds.get(json.cwd) ?? 0) + 1);
      }

      if (json.timestamp) {
        const ms = new Date(json.timestamp).getTime();
        if (!isNaN(ms)) {
          timestamps.push(ms);

          // Claude Code stamps this when a turn ends, carrying how long the turn
          // ran. The timestamp is the end, so the turn started durationMs earlier.
          if (
            json.type === 'system' &&
            json.subtype === 'turn_duration' &&
            typeof json.durationMs === 'number' &&
            json.durationMs > 0 &&
            Number.isFinite(json.durationMs)
          ) {
            turns.push([ms - json.durationMs, ms]);
          }
        }
      }
    } catch {
      // Malformed line — the file is append-only and may be mid-write.
    }
  }

  timestamps.sort((a, b) => a - b);
  turns.sort((a, b) => a[0] - b[0]);
  return { timestamps, cwds, turns };
}

/**
 * Picks the working intervals for one session.
 *
 * Prefers Claude Code's recorded turn durations, which measure the stretch the
 * agent was actually engaged — a twelve-minute `npm run` inside a turn counts
 * in full, and the minutes you spend reading the reply afterwards do not count
 * at all. Only when a session carries no such records does it fall back to
 * inferring activity from the spacing of log entries.
 *
 * Turns are merged because queued prompts can produce overlapping records, and
 * counting the same minute twice within one session would inflate the total.
 */
export function buildSessionIntervals(
  scan: SessionScan,
  idleSeconds: number = DEFAULT_IDLE_SECONDS,
): { intervals: Interval[]; source: TimingSource } {
  if (scan.turns.length > 0) {
    return { intervals: mergeIntervals(scan.turns), source: 'turns' };
  }
  return { intervals: buildIntervals(scan.timestamps, idleSeconds), source: 'gaps' };
}

/**
 * Turns a sorted timestamp list into activity intervals.
 *
 * Consecutive entries closer together than the idle threshold are considered
 * continuous work. A longer gap means the terminal sat idle, so that stretch
 * is excluded rather than bridged.
 */
export function buildIntervals(
  timestamps: number[],
  idleSeconds: number = DEFAULT_IDLE_SECONDS,
): Interval[] {
  const idleMs = idleSeconds * 1000;
  const intervals: Interval[] = [];

  for (let i = 1; i < timestamps.length; i++) {
    const start = timestamps[i - 1];
    const end = timestamps[i];
    if (end - start > idleMs) continue;
    if (end === start) continue;

    const last = intervals[intervals.length - 1];
    if (last && last[1] === start) {
      last[1] = end; // extend rather than fragment
    } else {
      intervals.push([start, end]);
    }
  }

  return intervals;
}

/** Clips intervals to [start, end), dropping any that fall entirely outside. */
export function clipToRange(intervals: Interval[], start: number, end: number): Interval[] {
  const out: Interval[] = [];
  for (const [a, b] of intervals) {
    const lo = Math.max(a, start);
    const hi = Math.min(b, end);
    if (hi > lo) out.push([lo, hi]);
  }
  return out;
}

/** Total covered time. Overlapping intervals are counted once each — see mergeIntervals. */
export function sumDuration(intervals: Interval[]): number {
  let total = 0;
  for (const [a, b] of intervals) total += b - a;
  return total;
}

/** Collapses overlapping intervals into a union. Used for wall-clock, not for summed totals. */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((x, y) => x[0] - y[0]);
  const out: Interval[] = [[sorted[0][0], sorted[0][1]]];

  for (let i = 1; i < sorted.length; i++) {
    const [a, b] = sorted[i];
    const last = out[out.length - 1];
    if (a <= last[1]) {
      if (b > last[1]) last[1] = b;
    } else {
      out.push([a, b]);
    }
  }

  return out;
}

/**
 * Cuts an interval at local midnight so a session running past 00:00
 * contributes to both days instead of landing entirely on the day it started.
 */
export function splitIntervalByDay(interval: Interval): Array<{ day: string; interval: Interval }> {
  const [start, end] = interval;
  const parts: Array<{ day: string; interval: Interval }> = [];

  let cursor = start;
  while (cursor < end) {
    const d = new Date(cursor);
    const nextMidnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
    const stop = Math.min(end, nextMidnight);
    parts.push({ day: toLocalDayKey(cursor), interval: [cursor, stop] });
    cursor = stop;
  }

  return parts;
}

/** Same cut as splitIntervalByDay, reduced to per-day durations. */
export function splitAtLocalMidnight(interval: Interval): Array<{ day: string; ms: number }> {
  return splitIntervalByDay(interval).map(({ day, interval: [a, b] }) => ({ day, ms: b - a }));
}

/** Local-time YYYY-MM-DD. Deliberately not toISOString(), which would shift by the UTC offset. */
export function toLocalDayKey(ms: number): string {
  const d = new Date(ms);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

function splitPath(p: string): string[] {
  return p.split(/[\\/]+/).filter(Boolean);
}

function isUnder(child: string[], parent: string[]): boolean {
  if (child.length < parent.length) return false;
  for (let i = 0; i < parent.length; i++) {
    if (child[i].toLowerCase() !== parent[i].toLowerCase()) return false;
  }
  return true;
}

/**
 * Picks the project root from every `cwd` a session reported.
 *
 * `cwd` tracks the shell, so one session yields many values as you move into
 * subfolders — and occasionally a stale path that never really existed. Taking
 * the first or most frequent value gets both cases wrong. Instead choose the
 * candidate that the greatest number of entries sit beneath, preferring the
 * shallower path on ties, which lands on the true repo root and lets rare
 * outliers lose.
 */
export function resolveProjectRoot(cwds: Map<string, number>): string | null {
  if (cwds.size === 0) return null;

  const candidates = [...cwds.entries()].map(([raw, count]) => ({
    raw: raw.replace(/[\\/]+$/, ''),
    segments: splitPath(raw),
    count,
  }));

  let best: { raw: string; covered: number; depth: number } | null = null;

  for (const candidate of candidates) {
    let covered = 0;
    for (const other of candidates) {
      if (isUnder(other.segments, candidate.segments)) covered += other.count;
    }
    const depth = candidate.segments.length;

    if (
      !best ||
      covered > best.covered ||
      (covered === best.covered && depth < best.depth)
    ) {
      best = { raw: candidate.raw, covered, depth };
    }
  }

  return best ? best.raw : null;
}

/** Reads one session file and returns its activity timeline. */
export async function loadSessionTimeline(
  filePath: string,
  idleSeconds: number = DEFAULT_IDLE_SECONDS,
): Promise<{ timeline: SessionTimeline; cwds: Map<string, number> }> {
  const scan = await scanSessionTimestamps(filePath);
  const { timestamps, cwds } = scan;
  const { intervals, source } = buildSessionIntervals(scan, idleSeconds);

  return {
    timeline: {
      sessionId: basename(filePath, '.jsonl'),
      filePath,
      intervals,
      activeMs: sumDuration(intervals),
      firstSeen: timestamps.length ? timestamps[0] : null,
      lastSeen: timestamps.length ? timestamps[timestamps.length - 1] : null,
      source,
    },
    cwds,
  };
}
