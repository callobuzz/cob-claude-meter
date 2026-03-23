import { renderStatusline } from '../../src/commands/statusline-cmd.js';

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
    const output = await renderStatusline(MOCK_STDIN, 'replace', { noColor: true });
    const lines = output.split('\n').filter(Boolean);
    expect(lines.length).toBe(2);
  });

  it('replace mode line 1 contains model name', async () => {
    const output = await renderStatusline(MOCK_STDIN, 'replace', { noColor: true });
    const lines = output.split('\n').filter(Boolean);
    expect(lines[0]).toContain('Opus');
  });

  it('replace mode line 1 contains progress bar', async () => {
    const output = await renderStatusline(MOCK_STDIN, 'replace', { noColor: true });
    const lines = output.split('\n').filter(Boolean);
    expect(lines[0]).toContain('%');
    expect(lines[0]).toMatch(/[\[=\s\]]/);
  });

  it('replace mode line 1 contains project name', async () => {
    const output = await renderStatusline(MOCK_STDIN, 'replace', { noColor: true });
    const lines = output.split('\n').filter(Boolean);
    expect(lines[0]).toContain('project');
  });

  it('inline mode produces single line', async () => {
    const output = await renderStatusline(MOCK_STDIN, 'inline', { noColor: true });
    const lines = output.split('\n').filter(Boolean);
    expect(lines.length).toBe(1);
  });

  it('add mode produces single line (meter data only)', async () => {
    const output = await renderStatusline(MOCK_STDIN, 'add', { noColor: true });
    const lines = output.split('\n').filter(Boolean);
    expect(lines.length).toBe(1);
  });

  it('output contains cost info', async () => {
    const output = await renderStatusline(MOCK_STDIN, 'inline', { noColor: true });
    expect(output).toContain('$');
  });

  it('handles null current_usage gracefully', async () => {
    const data = { ...MOCK_STDIN, context_window: { ...MOCK_STDIN.context_window, current_usage: null } };
    const output = await renderStatusline(data, 'replace', { noColor: true });
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
