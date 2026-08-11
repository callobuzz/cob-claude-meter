import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename } from 'node:path';

/** A contiguous span of activity: [startMs, endMs]. */
export type Interval = [number, number];

/**
 * How long a silence has to run before it counts as a break.
 *
 * A silence means no log entry at all — no turn in progress, no tool reporting
 * back, no prompt being sent. Below this, the stretch joins the work either
 * side of it; above it, it is dropped.
 */
export const DEFAULT_IDLE_SECONDS = 300;

/**
 * What evidence a session's total rests on.
 *
 * `turns` means Claude Code recorded turn durations, so the total is anchored
 * to measured spans and only the stretches between them depend on the
 * threshold. `gaps` means it recorded none, so the total is inferred from how
 * closely log entries sit together.
 */
export type TimingSource = 'turns' | 'gaps';

/**
 * Tools whose elapsed time is the agent waiting on a person, not working.
 *
 * Everything else — a build, a subagent, a background job — is the agent
 * blocked on its own work, which is time spent. These two block on you. They
 * are worth naming explicitly because they are long: across 60 days of real
 * logs `AskUserQuestion` spans totalled 35 hours, one of them lasting 8.
 */
const WAITING_ON_HUMAN = new Set(['AskUserQuestion', 'ExitPlanMode']);

/**
 * Tools that keep running after the turn that started them has ended.
 *
 * These are the reason tool spans exist at all, and the reason they cannot
 * simply be capped at the turn's recorded duration: a subagent or a background
 * job is genuinely working while Claude Code counts the turn as finished.
 * Anything else is foreground — it runs *during* the turn, so the turn's own
 * duration already covers it.
 */
const DETACHED_TOOLS = new Set(['Agent', 'Task', 'Workflow', 'Monitor']);

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
  /**
   * One interval per tool call, from its `tool_use` to its matching
   * `tool_result`.
   *
   * This is how work that leaves the main transcript still gets counted. A
   * subagent writes to its own file under `<session>/subagents/`, but the
   * parent records the `Agent` call that spawned it and the result that came
   * back, so the span is here without reading a second set of files — which
   * matters, since those transcripts are comparable in size to the sessions
   * themselves. Background jobs and long builds work the same way.
   */
  toolSpans: Interval[];
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
  const toolSpans: Interval[] = [];
  /** tool_use id -> when it started and what it was, until its result arrives. */
  const openTools = new Map<string, { at: number; name: string; detached: boolean }>();
  /** Foreground spans closed since the last turn ended, awaiting that turn's verdict. */
  let pending: Interval[] = [];

  const rl = createInterface({
    // A smaller read buffer than the 64KB default. Session logs run past 100MB
    // and a cold scan walks every one of them; on a Docker bind mount the
    // larger buffer is enough extra pressure to start returning ENOMEM, which
    // costs a whole session from the totals. Smaller chunks read slightly more
    // often and survive.
    input: createReadStream(filePath, { encoding: 'utf-8', highWaterMark: 16 * 1024 }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line) continue;
    // Cheap prefilter: session logs reach 100MB+ and most lines carry none of these.
    const hasTimestamp = line.indexOf('"timestamp"') !== -1;
    const hasCwd = line.indexOf('"cwd"') !== -1;
    const hasTool = line.indexOf('"tool_use') !== -1 || line.indexOf('"tool_result"') !== -1;
    if (!hasTimestamp && !hasCwd && !hasTool) continue;

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
            const turn: Interval = [ms - json.durationMs, ms];
            turns.push(turn);
            toolSpans.push(...keepHonestSpans(turn, json.durationMs, pending));
            pending = [];
          }

          collectToolSpans(json, ms, openTools, toolSpans, pending);
        }
      }
    } catch {
      // Malformed line — the file is append-only and may be mid-write.
    }
  }

  // Spans still pending when the file ends belong to a turn that never closed —
  // the session is mid-flight. There is no recorded duration to judge them
  // against, so they stand on their own.
  toolSpans.push(...pending);

  timestamps.sort((a, b) => a - b);
  turns.sort((a, b) => a[0] - b[0]);
  // Ordered by end as well as start: spans now arrive from two buckets
  // depending on whether the tool was detached, so start alone would leave the
  // order dependent on which bucket a span happened to take.
  toolSpans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return { timestamps, cwds, turns, toolSpans };
}

/**
 * Decides whether a turn's foreground tool spans are believable.
 *
 * Claude Code's `durationMs` is how long the turn actually ran, and it already
 * includes the tools that ran inside it — that is what makes a twelve-minute
 * build count as twelve minutes. So a foreground tool cannot honestly have been
 * open for longer than the turn: if the span union exceeds the recorded
 * duration, the difference is time the tool sat open while the turn was *not*
 * running, which is the agent waiting for you to approve it.
 *
 * When that happens the spans are dropped and the turn's own duration stands.
 * The turn is not shortened — nothing here can reduce measured work — it simply
 * stops being padded by the wait.
 *
 * Across 30 days of real logs this fires on 12 turns out of 3,114 and removes
 * 3.6 hours, the worst single case being 87 minutes of accumulated approval
 * waits inside one turn. Detached tools never reach this function.
 */
function keepHonestSpans(turn: Interval, durationMs: number, spans: Interval[]): Interval[] {
  if (spans.length === 0) return spans;
  const claimed = sumDuration(mergeIntervals([turn, ...spans]));
  return claimed > durationMs ? [] : spans;
}

/**
 * Pairs a `tool_use` with the `tool_result` that echoes its id.
 *
 * Tools still open when the file ends are dropped: an unfinished call has no
 * measured end, and guessing one would invent time. In practice this is rare —
 * across 60 days of logs every one of 71,870 results matched an opener.
 */
function collectToolSpans(
  json: { message?: { content?: unknown } },
  ms: number,
  open: Map<string, { at: number; name: string; detached: boolean }>,
  detachedOut: Interval[],
  pending: Interval[],
): void {
  const content = json.message?.content;
  if (!Array.isArray(content)) return;

  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as {
      type?: string;
      id?: string;
      name?: string;
      tool_use_id?: string;
      input?: { run_in_background?: unknown };
    };

    if (b.type === 'tool_use' && typeof b.id === 'string') {
      const name = typeof b.name === 'string' ? b.name : '';
      open.set(b.id, {
        at: ms,
        name,
        detached: DETACHED_TOOLS.has(name) || b.input?.run_in_background === true,
      });
    } else if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
      const started = open.get(b.tool_use_id);
      if (!started) continue;
      open.delete(b.tool_use_id);
      if (ms <= started.at || WAITING_ON_HUMAN.has(started.name)) continue;

      // Detached work outlives its turn by design, so it is never weighed
      // against that turn's duration. Foreground work is.
      if (started.detached) detachedOut.push([started.at, ms]);
      else pending.push([started.at, ms]);
    }
  }
}

/**
 * Picks the working intervals for one session.
 *
 * Idle means nothing was happening: nothing running, nothing being typed.
 * Everything else is work. So a moment counts if any of three kinds of evidence
 * covers it:
 *
 * - a recorded turn duration, which covers a long silent tool run inside a turn;
 * - a tool span, which covers a subagent or background job whose own output
 *   never reaches this file;
 * - log activity either side, where consecutive entries sit closer together
 *   than the idle threshold — compaction, queued prompts, and you typing.
 *
 * None of the three is sufficient alone. Turn records miss real work: across 60
 * days of logs, 5.1% of assistant messages and tool results fall outside every
 * turn record, worth about 18 hours. Activity alone misses the silent build.
 * Tool spans alone miss the thinking between calls.
 *
 * Merging is what makes combining them safe — overlapping evidence collapses
 * instead of counting the same minute twice, which is also why a subagent
 * running inside its parent turn adds nothing.
 */
export function buildSessionIntervals(
  scan: SessionScan,
  idleSeconds: number = DEFAULT_IDLE_SECONDS,
): { intervals: Interval[]; source: TimingSource } {
  const activity = buildIntervals(scan.timestamps, idleSeconds);
  const evidence = mergeIntervals([...scan.turns, ...scan.toolSpans, ...activity]);

  return {
    intervals: bridgeGaps(evidence, idleSeconds),
    source: scan.turns.length > 0 ? 'turns' : 'gaps',
  };
}

/**
 * Joins intervals separated by less than the idle threshold.
 *
 * The threshold has exactly one job: decide how long a silence has to run
 * before it stops being part of the work either side of it. Applying it to the
 * merged evidence rather than to raw timestamps is what makes that consistent —
 * otherwise a minute between a turn ending and a subagent starting would be
 * counted or dropped depending on whether a log line happened to land in it.
 *
 * Expects merged input, so the intervals are sorted and non-overlapping.
 */
export function bridgeGaps(intervals: Interval[], idleSeconds: number): Interval[] {
  if (intervals.length === 0) return [];
  const idleMs = idleSeconds * 1000;
  const out: Interval[] = [[intervals[0][0], intervals[0][1]]];

  for (let i = 1; i < intervals.length; i++) {
    const [a, b] = intervals[i];
    const last = out[out.length - 1];
    if (a - last[1] <= idleMs) {
      if (b > last[1]) last[1] = b;
    } else {
      out.push([a, b]);
    }
  }

  return out;
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
