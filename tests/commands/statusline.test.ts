import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderStatusline } from '../../src/commands/statusline-cmd.js';

/**
 * A real cache directory, just not the developer's own.
 *
 * Rendering defaults to `~/.claude-meter` and rescans every session log when
 * that cache is stale. Pointed at the real home directory these tests were
 * both slow and non-deterministic — output depended on whatever the machine
 * had cached, which is why two of them failed intermittently in full runs and
 * passed in isolation.
 */
const CACHE_DIR = mkdtempSync(join(tmpdir(), 'meter-statusline-'));
const RENDER_OPTS = { noColor: true, cacheDir: CACHE_DIR, autoRefresh: false };

afterAll(() => {
  rmSync(CACHE_DIR, { recursive: true, force: true });
});

const MOCK_WITH_RATE_LIMITS = {
  ...{
    model: { id: 'claude-opus-4-6', display_name: 'Opus' },
    context_window: {
      current_usage: {
        input_tokens: 50000,
        output_tokens: 10000,
        cache_read_input_tokens: 80000,
        cache_creation_input_tokens: 20000,
      },
      context_window_size: 200000,
      used_percentage: 45,
    },
    workspace: { current_dir: '/home/user/project' },
    cost: { total_cost_usd: 0.42 },
  },
  rate_limits: {
    five_hour: {
      used_percentage: 5,
      resets_at: Math.floor(Date.now() / 1000) + 4 * 3600 + 35 * 60,
    },
    seven_day: {
      used_percentage: 3,
      resets_at: Math.floor(Date.now() / 1000) + 47 * 3600,
    },
  },
};

const MOCK_STDIN = {
  model: { id: 'claude-opus-4-6', display_name: 'Opus' },
  context_window: {
    current_usage: {
      input_tokens: 50000,
      output_tokens: 10000,
      cache_read_input_tokens: 80000,
      cache_creation_input_tokens: 20000,
    },
    context_window_size: 200000,
    used_percentage: 45,
  },
  workspace: { current_dir: '/home/user/project' },
  cost: { total_cost_usd: 0.42 },
};

describe('renderStatusline', () => {
  it('replace mode produces 2 lines', async () => {
    const output = await renderStatusline(MOCK_STDIN, 'replace', RENDER_OPTS);
    const lines = output.split('\n').filter(Boolean);
    expect(lines.length).toBe(2);
  });

  it('replace mode line 1 contains model name', async () => {
    const output = await renderStatusline(MOCK_STDIN, 'replace', RENDER_OPTS);
    const lines = output.split('\n').filter(Boolean);
    expect(lines[0]).toContain('Opus');
  });

  it('replace mode line 1 contains progress bar', async () => {
    const output = await renderStatusline(MOCK_STDIN, 'replace', RENDER_OPTS);
    const lines = output.split('\n').filter(Boolean);
    expect(lines[0]).toContain('%');
    expect(lines[0]).toMatch(/[\[=\s\]]/);
  });

  it('replace mode line 1 contains project name', async () => {
    const output = await renderStatusline(MOCK_STDIN, 'replace', RENDER_OPTS);
    const lines = output.split('\n').filter(Boolean);
    expect(lines[0]).toContain('project');
  });

  it('inline mode produces single line', async () => {
    const output = await renderStatusline(MOCK_STDIN, 'inline', RENDER_OPTS);
    const lines = output.split('\n').filter(Boolean);
    expect(lines.length).toBe(1);
  });

  it('add mode produces single line (meter data only)', async () => {
    const output = await renderStatusline(MOCK_STDIN, 'add', RENDER_OPTS);
    const lines = output.split('\n').filter(Boolean);
    expect(lines.length).toBe(1);
  });

  it('output contains cost info', async () => {
    const output = await renderStatusline(MOCK_STDIN, 'inline', RENDER_OPTS);
    expect(output).toContain('$');
  });

  it('handles null current_usage gracefully', async () => {
    const data = { ...MOCK_STDIN, context_window: { ...MOCK_STDIN.context_window, current_usage: null } };
    const output = await renderStatusline(data, 'replace', RENDER_OPTS);
    expect(output.length).toBeGreaterThan(0);
  });
});

describe('buildBlockBar', () => {
  it('returns all empty blocks at 0%', async () => {
    const { buildBlockBar } = await import('../../src/commands/statusline-cmd.js');
    expect(buildBlockBar(0, 8)).toBe('░░░░░░░░');
  });

  it('returns all filled blocks at 100%', async () => {
    const { buildBlockBar } = await import('../../src/commands/statusline-cmd.js');
    expect(buildBlockBar(100, 8)).toBe('████████');
  });

  it('returns proportional fill at 50%', async () => {
    const { buildBlockBar } = await import('../../src/commands/statusline-cmd.js');
    expect(buildBlockBar(50, 8)).toBe('████░░░░');
  });
});

describe('formatTimeRemaining', () => {
  it('formats 5-hour window time remaining', async () => {
    const { formatTimeRemaining } = await import('../../src/commands/statusline-cmd.js');
    const now = Math.floor(Date.now() / 1000) * 1000; // align to second boundary
    const resetsAt = Math.floor(now / 1000) + (4 * 3600 + 35 * 60); // 4h 35m from now
    const result = formatTimeRemaining(resetsAt, '5h', now);
    expect(result).toBe('4h 35m / 5h');
  });

  it('formats 7-day window time remaining', async () => {
    const { formatTimeRemaining } = await import('../../src/commands/statusline-cmd.js');
    const now = Math.floor(Date.now() / 1000) * 1000; // align to second boundary
    const resetsAt = Math.floor(now / 1000) + (47 * 3600); // 1d 23h from now
    const result = formatTimeRemaining(resetsAt, '7d', now);
    expect(result).toBe('1d 23h / 7d');
  });

  it('returns null when resets_at is in the past', async () => {
    const { formatTimeRemaining } = await import('../../src/commands/statusline-cmd.js');
    const now = Date.now();
    const resetsAt = Math.floor(now / 1000) - 60; // 1 min ago
    const result = formatTimeRemaining(resetsAt, '5h', now);
    expect(result).toBeNull();
  });

  it('formats zero remaining as 0h 0m for 5h window', async () => {
    const { formatTimeRemaining } = await import('../../src/commands/statusline-cmd.js');
    const now = Date.now();
    const resetsAt = Math.floor(now / 1000) + 30; // 30 seconds from now
    const result = formatTimeRemaining(resetsAt, '5h', now);
    expect(result).toBe('0h 0m / 5h');
  });
});

describe('rate limit line', () => {
  it('replace mode produces 3 lines when rate_limits present', async () => {
    const output = await renderStatusline(MOCK_WITH_RATE_LIMITS, 'replace', RENDER_OPTS);
    const lines = output.split('\n').filter(Boolean);
    expect(lines.length).toBe(3);
  });

  it('line 3 contains Usage label', async () => {
    const output = await renderStatusline(MOCK_WITH_RATE_LIMITS, 'replace', RENDER_OPTS);
    const lines = output.split('\n').filter(Boolean);
    expect(lines[2]).toContain('Usage');
  });

  it('line 3 contains block bar characters', async () => {
    const output = await renderStatusline(MOCK_WITH_RATE_LIMITS, 'replace', RENDER_OPTS);
    const lines = output.split('\n').filter(Boolean);
    expect(lines[2]).toMatch(/[█░]/);
  });

  it('line 3 contains percentage', async () => {
    const output = await renderStatusline(MOCK_WITH_RATE_LIMITS, 'replace', RENDER_OPTS);
    const lines = output.split('\n').filter(Boolean);
    expect(lines[2]).toContain('5%');
  });

  it('line 3 contains time remaining', async () => {
    const output = await renderStatusline(MOCK_WITH_RATE_LIMITS, 'replace', RENDER_OPTS);
    const lines = output.split('\n').filter(Boolean);
    expect(lines[2]).toContain('/ 5h');
    expect(lines[2]).toContain('/ 7d');
  });

  it('replace mode stays 2 lines without rate_limits', async () => {
    const output = await renderStatusline(MOCK_STDIN, 'replace', RENDER_OPTS);
    const lines = output.split('\n').filter(Boolean);
    expect(lines.length).toBe(2);
  });

  it('add mode ignores rate_limits', async () => {
    const output = await renderStatusline(MOCK_WITH_RATE_LIMITS, 'add', RENDER_OPTS);
    const lines = output.split('\n').filter(Boolean);
    expect(lines.length).toBe(1);
  });

  it('inline mode ignores rate_limits', async () => {
    const output = await renderStatusline(MOCK_WITH_RATE_LIMITS, 'inline', RENDER_OPTS);
    const lines = output.split('\n').filter(Boolean);
    expect(lines.length).toBe(1);
  });

  it('handles only five_hour present', async () => {
    const data = {
      ...MOCK_STDIN,
      rate_limits: {
        five_hour: {
          used_percentage: 10,
          resets_at: Math.floor(Date.now() / 1000) + 3600,
        },
      },
    };
    const output = await renderStatusline(data, 'replace', RENDER_OPTS);
    const lines = output.split('\n').filter(Boolean);
    expect(lines.length).toBe(3);
    expect(lines[2]).toContain('/ 5h');
    expect(lines[2]).not.toContain('/ 7d');
  });

  it('handles only seven_day present', async () => {
    const data = {
      ...MOCK_STDIN,
      rate_limits: {
        seven_day: {
          used_percentage: 15,
          resets_at: Math.floor(Date.now() / 1000) + 24 * 3600,
        },
      },
    };
    const output = await renderStatusline(data, 'replace', RENDER_OPTS);
    const lines = output.split('\n').filter(Boolean);
    expect(lines.length).toBe(3);
    expect(lines[2]).toContain('/ 7d');
    expect(lines[2]).not.toContain('/ 5h');
  });

  it('handles utilization field name (alternative to used_percentage)', async () => {
    const data = {
      ...MOCK_STDIN,
      rate_limits: {
        five_hour: {
          utilization: 12,
          resets_at: Math.floor(Date.now() / 1000) + 3600,
        },
        seven_day: {
          utilization: 8,
          resets_at: Math.floor(Date.now() / 1000) + 48 * 3600,
        },
      },
    };
    const output = await renderStatusline(data as any, 'replace', RENDER_OPTS);
    const lines = output.split('\n').filter(Boolean);
    expect(lines.length).toBe(3);
    expect(lines[2]).toContain('12%');
    expect(lines[2]).toContain('8%');
  });
});
