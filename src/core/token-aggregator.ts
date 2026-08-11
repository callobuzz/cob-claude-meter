import { Dirent, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ModelTokens } from './aggregator.js';
import { CostResult, calculateCosts } from './cost-calculator.js';
import { ModelRates, isPlaceholderModel } from './pricing.js';
import { LogEntry, scanFile } from './scanner.js';
import { dayFullyInRange } from './day-archive.js';
import { findProjectDirs, leafName } from './time-aggregator.js';
import { resolveProjectRoot, toLocalDayKey } from './time-tracker.js';
import { PackedTokens, TokenCache, emptyPacked } from './token-cache.js';
import { ArchivedTokenDay, TOKEN_ALGO_VERSION, TokenArchive, wouldErodeTokens } from './token-archive.js';

/**
 * Tokens and cost for one slice — a project, a day, a model, or everything.
 *
 * `fresh` and `full` are both carried because they answer different questions
 * and differ by orders of magnitude. Fresh is what the conversation actually
 * generated; full includes cache reads, which on a long session dwarf it by
 * a factor of hundreds and dominate the bill.
 */
export interface TokenSummary {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  cache5m: number;
  cache1h: number;
  webSearches: number;
  webFetches: number;
  entries: number;
  /** input + output. */
  fresh: number;
  /** input + output + cache read + cache creation. */
  full: number;
  costUsd: number;
}

export interface ProjectTokens {
  /** Resolved project path — the same identity `ProjectTime.id` uses. */
  id: string;
  path: string;
  name: string;
  usage: TokenSummary;
  /** Local day → that day's usage for this project. */
  byDay: Record<string, TokenSummary>;
  byModel: Record<string, TokenSummary>;
  sessionCount: number;
  activeDays: number;
  firstSeen: number | null;
  lastSeen: number | null;
}

export interface DayTokens {
  day: string;
  usage: TokenSummary;
  projects: Array<{ id: string; name: string; costUsd: number; fresh: number; full: number }>;
}

export interface TokenReport {
  generatedAt: string;
  range: { start: number; end: number };
  totals: TokenSummary;
  projects: ProjectTokens[];
  /** Every day in range that saw usage, ascending. */
  days: DayTokens[];
  byModel: Record<string, TokenSummary & { fallback: boolean }>;
  pricing: {
    source: string;
    version: string;
    /** Models the bundled table could not price. Their cost is a guess. */
    guessedModels: string[];
  };
  scan: {
    filesScanned: number;
    filesFromCache: number;
    filesFailed: number;
    projects: number;
    sessions: number;
    /** Project-days served from the archive because their logs are gone. */
    daysRestored: number;
    durationMs: number;
  };
  warnings: string[];
}

export interface TokenReportOptions {
  logPaths: string[];
  start?: number;
  end?: number;
  cache?: TokenCache;
  /** Durable history. Without it the report sees only logs that still exist. */
  archive?: TokenArchive;
  overrides?: Record<string, Partial<ModelRates>>;
  onProgress?: (done: number, total: number, label: string) => void;
}

export function emptySummary(): TokenSummary {
  return {
    input: 0, output: 0, cacheRead: 0, cacheCreate: 0, cache5m: 0, cache1h: 0,
    webSearches: 0, webFetches: 0, entries: 0, fresh: 0, full: 0, costUsd: 0,
  };
}

function addPacked(target: PackedTokens, entry: LogEntry): void {
  target[0] += entry.input_tokens;
  target[1] += entry.output_tokens;
  target[2] += entry.cache_read_input_tokens;
  target[3] += entry.cache_creation_input_tokens;
  target[4] += entry.cache_5m_input_tokens;
  target[5] += entry.cache_1h_input_tokens;
  target[6] += entry.web_searches;
  target[7] += entry.web_fetches;
  target[8] += 1;
}

function mergePacked(target: PackedTokens, source: PackedTokens): void {
  for (let i = 0; i < target.length; i++) target[i] += source[i];
}

function packedToModelTokens(p: PackedTokens): ModelTokens {
  return {
    input_tokens: p[0],
    output_tokens: p[1],
    cache_read_input_tokens: p[2],
    cache_creation_input_tokens: p[3],
    cache_5m_input_tokens: p[4],
    cache_1h_input_tokens: p[5],
    web_searches: p[6],
    web_fetches: p[7],
    entries_matched: p[8],
  };
}

/**
 * Prices a set of models and folds them into one summary.
 *
 * Costing happens here rather than on the totals because rates are per model:
 * summing opus and haiku tokens first and pricing the sum once would bill the
 * cheap model at the expensive rate.
 */
function summarize(
  models: Record<string, PackedTokens>,
  overrides?: Record<string, Partial<ModelRates>>,
): { summary: TokenSummary; cost: CostResult } {
  const byModel: Record<string, ModelTokens> = {};
  for (const [model, packed] of Object.entries(models)) {
    byModel[model] = packedToModelTokens(packed);
  }

  const cost = calculateCosts(
    { period: { label: 'slice', start: '', end: '' }, totals: zeroTotals(), by_model: byModel },
    overrides,
  );

  const summary = emptySummary();
  for (const packed of Object.values(models)) {
    summary.input += packed[0];
    summary.output += packed[1];
    summary.cacheRead += packed[2];
    summary.cacheCreate += packed[3];
    summary.cache5m += packed[4];
    summary.cache1h += packed[5];
    summary.webSearches += packed[6];
    summary.webFetches += packed[7];
    summary.entries += packed[8];
  }
  summary.fresh = summary.input + summary.output;
  summary.full = summary.fresh + summary.cacheRead + summary.cacheCreate;
  summary.costUsd = cost.total;

  return { summary, cost };
}

function zeroTotals() {
  return {
    input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0, cache_5m_input_tokens: 0, cache_1h_input_tokens: 0,
    web_searches: 0, web_fetches: 0, entries_matched: 0,
    fresh_total: 0, full_total: 0, sessions: 0, files_scanned: 0,
  };
}

/** What one log file contributed, before it is attributed to a project. */
interface FileTokens {
  daySessions: Record<string, string[]>;
  cwds: Array<[string, number]>;
  firstSeen: number | null;
  lastSeen: number | null;
  days: Record<string, Record<string, PackedTokens>>;
}

/**
 * Every log file whose usage belongs to this project, subagent transcripts included.
 *
 * This is where token accounting parts company with hours accounting. The hours
 * pipeline reads only top-level session logs, because a subagent runs *inside*
 * its parent turn — counting its transcript as another session would bill the
 * same wall-clock twice. Tokens are the opposite: a subagent spends its own
 * budget on top of the parent's, and on a real log directory that is the
 * majority of the traffic. Skipping these files silently under-reports the bill.
 */
function findUsageFiles(projectDir: string): Array<{ path: string; countsAsSession: boolean }> {
  const out: Array<{ path: string; countsAsSession: boolean }> = [];

  let entries: Dirent[];
  try {
    entries = readdirSync(projectDir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      out.push({ path: join(projectDir, entry.name), countsAsSession: true });
      continue;
    }
    if (!entry.isDirectory()) continue;

    // Claude Code writes subagent transcripts to <session-id>/subagents/*.jsonl.
    const subagentDir = join(projectDir, entry.name, 'subagents');
    try {
      for (const sub of readdirSync(subagentDir, { withFileTypes: true })) {
        if (!sub.isFile() || !sub.name.endsWith('.jsonl')) continue;
        // Spend counts; the session does not — it is the parent's.
        out.push({ path: join(subagentDir, sub.name), countsAsSession: false });
      }
    } catch {
      // No subagents under this session.
    }
  }

  return out;
}

async function readFileTokens(filePath: string, countsAsSession: boolean): Promise<FileTokens> {
  const days: Record<string, Record<string, PackedTokens>> = {};
  const daySessionSets = new Map<string, Set<string>>();
  const cwds = new Map<string, number>();
  let firstSeen: number | null = null;
  let lastSeen: number | null = null;

  // No date filter: the scan is the expensive part and it costs the same either
  // way, so read once and keep every day. Range selection happens downstream
  // over the rolled-up days, which is why switching ranges is free afterwards.
  await scanFile(filePath, (entry) => {
    const ms = entry.timestamp.getTime();
    const day = toLocalDayKey(ms);

    const byModel = days[day] ?? (days[day] = {});
    const packed = byModel[entry.model] ?? (byModel[entry.model] = emptyPacked());
    addPacked(packed, entry);

    if (entry.cwd) cwds.set(entry.cwd, (cwds.get(entry.cwd) ?? 0) + 1);
    if (countsAsSession && entry.sessionId) {
      const set = daySessionSets.get(day) ?? new Set<string>();
      daySessionSets.set(day, set);
      set.add(entry.sessionId);
    }
    if (firstSeen === null || ms < firstSeen) firstSeen = ms;
    if (lastSeen === null || ms > lastSeen) lastSeen = ms;
  });

  const daySessions: Record<string, string[]> = {};
  for (const [day, set] of daySessionSets) daySessions[day] = [...set];

  return { daySessions, cwds: [...cwds.entries()], firstSeen, lastSeen, days };
}

interface ProjectAccum {
  path: string;
  name: string;
  firstSeen: number | null;
  lastSeen: number | null;
  /** day → model → counters, unfiltered. Sliced to the range at the end. */
  days: Map<string, Record<string, PackedTokens>>;
  /** day → session ids, so a range counts only the sessions that ran in it. */
  daySessions: Map<string, Set<string>>;
}

/**
 * Tokens and cost, rolled up per project, per day and per model.
 *
 * Project identity is resolved exactly the way `buildTimeReport` resolves it —
 * same directory walk, same `resolveProjectRoot`, same rename merging — so an
 * hours row and a cost row for the same work always carry the same id. Anything
 * else and the two views of one project would disagree on its name.
 */
export async function buildTokenReport(options: TokenReportOptions): Promise<TokenReport> {
  const startedAt = Date.now();
  const rangeStart = options.start ?? 0;
  const rangeEnd = options.end ?? Number.MAX_SAFE_INTEGER;
  const cache = options.cache;
  const warnings: string[] = [];

  // 1. Enumerate every project directory and its session files.
  const projectDirs: string[] = [];
  for (const logRoot of options.logPaths) {
    projectDirs.push(...findProjectDirs(logRoot));
  }

  const work: Array<{ dir: string; files: Array<{ path: string; countsAsSession: boolean }> }> = [];
  const livePaths = new Set<string>();
  for (const dir of projectDirs) {
    const files = findUsageFiles(dir);
    if (files.length === 0) continue;
    for (const f of files) livePaths.add(f.path);
    work.push({ dir, files });
  }

  const totalFiles = work.reduce((acc, w) => acc + w.files.length, 0);
  let done = 0;
  let filesFromCache = 0;
  let filesFailed = 0;

  // 2. Read every session, reusing cached breakdowns where the file is unchanged.
  const buckets: Array<{ dirName: string; cwds: Map<string, number>; files: FileTokens[] }> = [];

  for (const { dir, files } of work) {
    const bucket = { dirName: basename(dir), cwds: new Map<string, number>(), files: [] as FileTokens[] };

    for (const { path: filePath, countsAsSession } of files) {
      const cached = cache?.get(filePath) ?? null;

      if (cached) {
        filesFromCache++;
        bucket.files.push({
          daySessions: cached.daySessions,
          cwds: cached.cwds,
          firstSeen: cached.firstSeen,
          lastSeen: cached.lastSeen,
          days: cached.days,
        });
      } else {
        try {
          const parsed = await readFileTokens(filePath, countsAsSession);
          cache?.set(filePath, parsed);
          bucket.files.push(parsed);
        } catch (err) {
          // One unreadable log must not take down the whole report; report the
          // gap instead so the totals are visibly incomplete, not silently.
          filesFailed++;
          warnings.push(`Skipped ${basename(filePath)}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      done++;
      options.onProgress?.(done, totalFiles, basename(filePath));
    }

    for (const parsed of bucket.files) {
      for (const [cwd, count] of parsed.cwds) {
        bucket.cwds.set(cwd, (bucket.cwds.get(cwd) ?? 0) + count);
      }
    }

    buckets.push(bucket);
  }

  cache?.prune(livePaths);
  const saved = cache?.save();
  if (saved && !saved.ok) {
    warnings.push(`Token cache could not be saved (${saved.reason}); the next load will be slower.`);
  }

  // 3. Resolve each directory to a real project path, merging directories that
  //    point at the same place — a folder rename leaves two behind.
  const accums = new Map<string, ProjectAccum>();

  for (const bucket of buckets) {
    const resolved = resolveProjectRoot(bucket.cwds) ?? bucket.dirName;
    const key = resolved.toLowerCase();

    let accum = accums.get(key);
    if (!accum) {
      accum = {
        path: resolved,
        name: leafName(resolved),
        firstSeen: null,
        lastSeen: null,
        days: new Map(),
        daySessions: new Map(),
      };
      accums.set(key, accum);
    }

    for (const parsed of bucket.files) {
      for (const [day, ids] of Object.entries(parsed.daySessions)) {
        const set = accum.daySessions.get(day) ?? new Set<string>();
        accum.daySessions.set(day, set);
        for (const id of ids) set.add(id);
      }
      if (parsed.firstSeen !== null && (accum.firstSeen === null || parsed.firstSeen < accum.firstSeen)) {
        accum.firstSeen = parsed.firstSeen;
      }
      if (parsed.lastSeen !== null && (accum.lastSeen === null || parsed.lastSeen > accum.lastSeen)) {
        accum.lastSeen = parsed.lastSeen;
      }

      for (const [day, models] of Object.entries(parsed.days)) {
        let target = accum.days.get(day);
        if (!target) {
          target = {};
          accum.days.set(day, target);
        }
        for (const [model, packed] of Object.entries(models)) {
          const slot = target[model] ?? (target[model] = emptyPacked());
          mergePacked(slot, packed);
        }
      }
    }
  }

  // 3a. Record every finished day the logs still describe, then note which
  //     (project, day) pairs the logs produced so the archive cannot double them.
  const archive = options.archive;
  const livePairs = new Set<string>();

  for (const accum of accums.values()) {
    for (const [day, models] of accum.days) {
      livePairs.add(`${day} ${accum.path.toLowerCase()}`);
      if (!archive) continue;

      const entry: ArchivedTokenDay = {
        day,
        project: accum.path,
        name: accum.name,
        models,
        sessionCount: (accum.daySessions.get(day) ?? new Set()).size,
        algo: TOKEN_ALGO_VERSION,
      };

      // Refuse a write that would record the decay of a day whose sessions are
      // being deleted one at a time.
      if (wouldErodeTokens(archive.get(day, accum.path), entry)) continue;
      archive.put(entry);
    }
  }

  if (archive) {
    const saved = archive.save();
    if (!saved.ok) {
      warnings.push(`Token archive could not be saved (${saved.reason}); history for finished days may be lost when the logs expire.`);
    }
  }

  // 3b. Bring back days whose logs are gone. Only whole days inside the range:
  //     a half-covered day would contribute a fraction of its real usage.
  let daysRestored = 0;

  if (archive) {
    const startDay = toLocalDayKey(Math.max(0, rangeStart));
    const endDay = toLocalDayKey(Math.min(rangeEnd, Date.now()));

    for (const entry of archive.range(startDay, endDay)) {
      if (livePairs.has(`${entry.day} ${entry.project.toLowerCase()}`)) continue;
      if (!dayFullyInRange(entry.day, rangeStart, rangeEnd)) continue;

      const key = entry.project.toLowerCase();
      let accum = accums.get(key);
      if (!accum) {
        accum = {
          path: entry.project,
          name: entry.name,
          firstSeen: null,
          lastSeen: null,
          days: new Map(),
          daySessions: new Map(),
        };
        accums.set(key, accum);
      }

      const target = accum.days.get(entry.day) ?? {};
      accum.days.set(entry.day, target);
      for (const [model, packed] of Object.entries(entry.models)) {
        const slot = target[model] ?? (target[model] = emptyPacked());
        mergePacked(slot, packed);
      }

      // Session ids are not archived — only how many there were. Synthesise
      // distinct placeholders so the count survives without pretending to
      // know which sessions they were.
      const sessions = accum.daySessions.get(entry.day) ?? new Set<string>();
      accum.daySessions.set(entry.day, sessions);
      for (let i = 0; i < entry.sessionCount; i++) {
        sessions.add(`archived:${entry.day}:${key}:${i}`);
      }

      daysRestored++;
    }
  }

  // 4. Slice to the requested range and price everything.
  const inRange = (day: string): boolean => {
    const ms = dayStartMs(day);
    return ms >= dayFloor(rangeStart) && ms <= rangeEnd;
  };

  const projects: ProjectTokens[] = [];
  const dayAccum = new Map<string, Record<string, PackedTokens>>();
  const dayProjects = new Map<string, Map<string, PackedTokens>>();
  const grandModels: Record<string, PackedTokens> = {};

  for (const accum of accums.values()) {
    const projectModels: Record<string, PackedTokens> = {};
    const byDay: Record<string, TokenSummary> = {};
    const sessionsInRange = new Set<string>();

    for (const [day, models] of accum.days) {
      if (!inRange(day)) continue;
      for (const id of accum.daySessions.get(day) ?? []) sessionsInRange.add(id);

      const { summary } = summarize(models, options.overrides);
      if (summary.entries === 0) continue;
      byDay[day] = summary;

      for (const [model, packed] of Object.entries(models)) {
        const projectSlot = projectModels[model] ?? (projectModels[model] = emptyPacked());
        mergePacked(projectSlot, packed);

        const grandSlot = grandModels[model] ?? (grandModels[model] = emptyPacked());
        mergePacked(grandSlot, packed);

        const dayModels = dayAccum.get(day) ?? {};
        dayAccum.set(day, dayModels);
        const daySlot = dayModels[model] ?? (dayModels[model] = emptyPacked());
        mergePacked(daySlot, packed);

        const perProject = dayProjects.get(day) ?? new Map<string, PackedTokens>();
        dayProjects.set(day, perProject);
        const projectDaySlot = perProject.get(accum.path) ?? emptyPacked();
        mergePacked(projectDaySlot, packed);
        perProject.set(accum.path, projectDaySlot);
      }
    }

    if (Object.keys(byDay).length === 0) continue;

    const { summary } = summarize(projectModels, options.overrides);
    const byModel: Record<string, TokenSummary> = {};
    for (const [model, packed] of Object.entries(projectModels)) {
      byModel[model] = summarize({ [model]: packed }, options.overrides).summary;
    }

    projects.push({
      id: accum.path,
      path: accum.path,
      name: accum.name,
      usage: summary,
      byDay,
      byModel,
      sessionCount: sessionsInRange.size,
      activeDays: Object.keys(byDay).length,
      firstSeen: accum.firstSeen,
      lastSeen: accum.lastSeen,
    });
  }

  projects.sort((a, b) => b.usage.costUsd - a.usage.costUsd);

  const days: DayTokens[] = [...dayAccum.entries()]
    .map(([day, models]) => {
      const { summary } = summarize(models, options.overrides);
      const perProject = dayProjects.get(day) ?? new Map<string, PackedTokens>();
      const projectRows = [...perProject.entries()]
        .map(([path, packed]) => {
          const s = summarize({ all: packed }, options.overrides).summary;
          return { id: path, name: leafName(path), costUsd: s.costUsd, fresh: s.fresh, full: s.full };
        })
        .sort((a, b) => b.costUsd - a.costUsd);
      return { day, usage: summary, projects: projectRows };
    })
    .sort((a, b) => a.day.localeCompare(b.day));

  const { summary: totals, cost: grandCost } = summarize(grandModels, options.overrides);

  const byModel: Record<string, TokenSummary & { fallback: boolean }> = {};
  for (const [model, packed] of Object.entries(grandModels)) {
    // Placeholders like <synthetic> are Claude Code's own turns: always zero
    // tokens and zero cost. Listing them beside real models is noise.
    if (isPlaceholderModel(model)) continue;
    byModel[model] = {
      ...summarize({ [model]: packed }, options.overrides).summary,
      fallback: grandCost.by_model[model]?.fallback === true,
    };
  }

  const guessedModels = Object.entries(grandCost.by_model)
    .filter(([model, mc]) => mc.fallback && !isPlaceholderModel(model))
    .map(([model]) => model);

  return {
    generatedAt: new Date().toISOString(),
    range: { start: rangeStart, end: rangeEnd },
    totals,
    projects,
    days,
    byModel,
    pricing: {
      source: grandCost.pricing_source,
      version: grandCost.pricing_version,
      guessedModels,
    },
    scan: {
      filesScanned: totalFiles,
      filesFromCache,
      filesFailed,
      projects: projects.length,
      sessions: projects.reduce((acc, p) => acc + p.sessionCount, 0),
      daysRestored,
      durationMs: Date.now() - startedAt,
    },
    warnings,
  };
}

/** Midnight local time for a YYYY-MM-DD key. */
function dayStartMs(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

/**
 * Start of the local day a timestamp falls in.
 *
 * A day is the smallest unit a token entry is bucketed into, so a range that
 * begins mid-morning still has to include that whole day — otherwise "today"
 * would drop every turn taken before the range boundary and silently under-report.
 */
function dayFloor(ms: number): number {
  if (ms <= 0) return 0;
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
