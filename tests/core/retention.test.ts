import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DEFAULT_CLEANUP_PERIOD_DAYS,
  applyRetentionSetting,
  formatBytes,
  projectDiskUsage,
  readRetentionSetting,
  scanRetentionState,
} from '../../src/core/retention.js';
import { runRetentionCommand } from '../../src/commands/retention-cmd.js';

const DAY_MS = 86_400_000;

describe('readRetentionSetting', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'claude-meter-ret-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const settings = (body: string) => {
    const p = join(root, 'settings.json');
    writeFileSync(p, body, 'utf-8');
    return p;
  };

  it('falls back to the documented default when the file is missing', () => {
    const result = readRetentionSetting(join(root, 'nope.json'));
    expect(result.fileExists).toBe(false);
    expect(result.days).toBe(DEFAULT_CLEANUP_PERIOD_DAYS);
    expect(result.isDefault).toBe(true);
  });

  it('falls back to the default when the key is absent', () => {
    const result = readRetentionSetting(settings('{"model":"opus"}'));
    expect(result.fileExists).toBe(true);
    expect(result.days).toBe(DEFAULT_CLEANUP_PERIOD_DAYS);
    expect(result.isDefault).toBe(true);
  });

  it('reads an explicit value', () => {
    const result = readRetentionSetting(settings('{"cleanupPeriodDays":3650}'));
    expect(result.days).toBe(3650);
    expect(result.isDefault).toBe(false);
  });

  it('reports a parse error instead of guessing', () => {
    const result = readRetentionSetting(settings('{ not json'));
    expect(result.parseError).toBeTruthy();
    expect(result.days).toBe(DEFAULT_CLEANUP_PERIOD_DAYS);
  });
});

describe('applyRetentionSetting', () => {
  let root: string;
  let file: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'claude-meter-apply-'));
    file = join(root, 'settings.json');
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('inserts the key when absent and leaves every other setting alone', () => {
    const before = '{\n  "model": "opus",\n  "hooks": { "Stop": [] }\n}\n';
    writeFileSync(file, before, 'utf-8');

    const result = applyRetentionSetting(3650, file);
    expect(result).toMatchObject({ ok: true, changed: true, previous: null, days: 3650 });

    const after = JSON.parse(readFileSync(file, 'utf-8'));
    expect(after.cleanupPeriodDays).toBe(3650);
    expect(after.model).toBe('opus');
    expect(after.hooks).toEqual({ Stop: [] });
  });

  it('rewrites an existing value in place', () => {
    writeFileSync(file, '{\n  "cleanupPeriodDays": 30,\n  "model": "opus"\n}\n', 'utf-8');
    const result = applyRetentionSetting(365, file);
    expect(result).toMatchObject({ ok: true, changed: true, previous: 30, days: 365 });
    expect(JSON.parse(readFileSync(file, 'utf-8')).cleanupPeriodDays).toBe(365);
  });

  it('writes a backup of the previous file', () => {
    writeFileSync(file, '{"model":"opus"}', 'utf-8');
    const result = applyRetentionSetting(3650, file);
    expect(result.ok && result.changed).toBe(true);
    if (result.ok && result.changed) {
      expect(existsSync(result.backupPath)).toBe(true);
      expect(JSON.parse(readFileSync(result.backupPath, 'utf-8')).cleanupPeriodDays).toBeUndefined();
    }
  });

  it('leaves the file untouched when it is not valid JSON', () => {
    const broken = '{ this is not json';
    writeFileSync(file, broken, 'utf-8');
    const result = applyRetentionSetting(3650, file);
    expect(result.ok).toBe(false);
    expect(readFileSync(file, 'utf-8')).toBe(broken);
  });

  it('rejects a nonsensical retention', () => {
    writeFileSync(file, '{"model":"opus"}', 'utf-8');
    expect(applyRetentionSetting(0, file).ok).toBe(false);
    expect(applyRetentionSetting(-5, file).ok).toBe(false);
    expect(applyRetentionSetting(1.5, file).ok).toBe(false);
    // Untouched by any of the rejected attempts.
    expect(JSON.parse(readFileSync(file, 'utf-8')).cleanupPeriodDays).toBeUndefined();
  });

  it('reports no change when the value already matches', () => {
    writeFileSync(file, '{"cleanupPeriodDays":3650}', 'utf-8');
    expect(applyRetentionSetting(3650, file)).toMatchObject({ ok: true, changed: false });
  });

  it('preserves the surrounding formatting rather than reserialising', () => {
    const before = '{\n    "model": "opus",\n    "verbose": true\n}\n';
    writeFileSync(file, before, 'utf-8');
    applyRetentionSetting(3650, file);
    const after = readFileSync(file, 'utf-8');
    // The untouched lines survive character-for-character, four-space indent included.
    expect(after).toContain('    "model": "opus",');
    expect(after).toContain('    "verbose": true');
    expect(after).toContain('"cleanupPeriodDays": 3650');
  });
});

describe('scanRetentionState', () => {
  let root: string;
  let logs: string;
  const now = Date.UTC(2026, 6, 30);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'claude-meter-scan-'));
    logs = join(root, 'projects');
    mkdirSync(logs, { recursive: true });
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('counts surviving logs and the projects holding them', () => {
    const dir = join(logs, 'P--live');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.jsonl'), 'x'.repeat(100), 'utf-8');
    writeFileSync(join(dir, 'b.jsonl'), 'x'.repeat(200), 'utf-8');

    const state = scanRetentionState([logs], now);
    expect(state.sessionFiles).toBe(2);
    expect(state.totalBytes).toBe(300);
    expect(state.projectsWithLogs).toBe(1);
    expect(state.projectsWithoutLogs).toBe(0);
  });

  it('recognises a pruned project from its tombstone', () => {
    // A directory whose index still names transcripts that no longer exist is
    // exactly what Claude Code leaves behind after a cleanup sweep.
    const dir = join(logs, 'P--pruned');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'sessions-index.json'), JSON.stringify({
      version: 1,
      entries: [
        { sessionId: 'a', fullPath: join(dir, 'gone-a.jsonl'), messageCount: 40, modified: '2026-02-01T10:00:00Z', projectPath: 'C:\\old-app' },
        { sessionId: 'b', fullPath: join(dir, 'gone-b.jsonl'), messageCount: 12, modified: '2026-02-08T10:00:00Z', projectPath: 'C:\\old-app' },
      ],
    }), 'utf-8');

    const state = scanRetentionState([logs], now);
    expect(state.projectsWithoutLogs).toBe(1);
    expect(state.missingTranscripts).toBe(2);
    expect(state.pruned).toHaveLength(1);
    expect(state.pruned[0]).toMatchObject({
      path: 'C:\\old-app', sessions: 2, messages: 52, lastActivity: '2026-02-08',
    });
  });

  it('does not call a project pruned while it still has transcripts', () => {
    const dir = join(logs, 'P--partial');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'live.jsonl'), 'x', 'utf-8');
    writeFileSync(join(dir, 'sessions-index.json'), JSON.stringify({
      entries: [{ fullPath: join(dir, 'gone.jsonl'), messageCount: 5 }],
    }), 'utf-8');

    const state = scanRetentionState([logs], now);
    expect(state.missingTranscripts).toBe(1); // still worth counting
    expect(state.pruned).toHaveLength(0);     // but the project is not lost
  });

  it('survives an unreadable log root', () => {
    const state = scanRetentionState([join(root, 'missing')], now);
    expect(state.sessionFiles).toBe(0);
    expect(state.pruned).toEqual([]);
  });
});

describe('projectDiskUsage', () => {
  it('extrapolates from the window that survived', () => {
    const state = { totalBytes: 300, oldestAgeDays: 30 } as ReturnType<typeof scanRetentionState>;
    const usage = projectDiskUsage(state, 300);
    expect(usage.perDayBytes).toBe(10);
    expect(usage.projectedBytes).toBe(3000);
  });

  it('does not divide by zero on a fresh install', () => {
    const state = { totalBytes: 0, oldestAgeDays: null } as ReturnType<typeof scanRetentionState>;
    expect(projectDiskUsage(state, 3650).projectedBytes).toBe(0);
  });
});

describe('formatBytes', () => {
  it('scales through the units', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.0 GB');
  });
});

describe('runRetentionCommand', () => {
  let root: string;
  let file: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'claude-meter-cmd-'));
    file = join(root, 'settings.json');
    writeFileSync(file, '{\n  "model": "opus"\n}\n', 'utf-8');
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const read = () => JSON.parse(readFileSync(file, 'utf-8'));

  it('explains the cost and writes nothing on --dry-run', async () => {
    const out = await runRetentionCommand({ settings: file, dryRun: true, days: '3650' });
    expect(out).toContain('cleanupPeriodDays');
    expect(out).toContain('Disk.');
    expect(out).toContain('Privacy.');
    expect(out).toContain('Nothing already deleted comes back');
    expect(out).toContain('no changes written');
    expect(read().cleanupPeriodDays).toBeUndefined();
  });

  it('writes nothing when the user declines', async () => {
    const out = await runRetentionCommand({ settings: file, confirm: async () => false });
    expect(out).toContain('Cancelled');
    expect(read().cleanupPeriodDays).toBeUndefined();
  });

  it('asks before writing, and writes once confirmed', async () => {
    const asked: string[] = [];
    const out = await runRetentionCommand({
      settings: file,
      days: '3650',
      confirm: async (q) => { asked.push(q); return true; },
    });

    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('3650');
    expect(out).toContain('Done.');
    expect(read().cleanupPeriodDays).toBe(3650);
    expect(read().model).toBe('opus'); // untouched
  });

  it('does not prompt when --yes is given', async () => {
    let prompted = false;
    await runRetentionCommand({
      settings: file, days: '400', yes: true,
      confirm: async () => { prompted = true; return true; },
    });
    expect(prompted).toBe(false);
    expect(read().cleanupPeriodDays).toBe(400);
  });

  it('rejects a bad --days without touching the file', async () => {
    const out = await runRetentionCommand({ settings: file, days: 'forever' });
    expect(out).toContain('Invalid --days');
    expect(read().cleanupPeriodDays).toBeUndefined();
  });

  it('reports when retention already exceeds the request', async () => {
    writeFileSync(file, '{"cleanupPeriodDays":3650}', 'utf-8');
    const out = await runRetentionCommand({ settings: file, days: '365' });
    expect(out).toContain('Nothing to change');
  });

  it('refuses to edit a settings file it cannot parse', async () => {
    const broken = '{ broken';
    writeFileSync(file, broken, 'utf-8');
    const out = await runRetentionCommand({ settings: file, confirm: async () => true });
    expect(out).toContain('Refusing to edit');
    expect(readFileSync(file, 'utf-8')).toBe(broken);
  });
});
