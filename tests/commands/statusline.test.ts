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
  it('replace mode produces 2 lines', () => {
    const output = renderStatusline(MOCK_STDIN, 'replace', { noColor: true });
    const lines = output.split('\n').filter(Boolean);
    expect(lines.length).toBe(2);
  });

  it('replace mode line 1 contains model name', () => {
    const output = renderStatusline(MOCK_STDIN, 'replace', { noColor: true });
    const lines = output.split('\n').filter(Boolean);
    expect(lines[0]).toContain('Opus');
  });

  it('replace mode line 1 contains progress bar', () => {
    const output = renderStatusline(MOCK_STDIN, 'replace', { noColor: true });
    const lines = output.split('\n').filter(Boolean);
    expect(lines[0]).toContain('%');
    expect(lines[0]).toMatch(/[\[=\s\]]/);
  });

  it('replace mode line 1 contains project name', () => {
    const output = renderStatusline(MOCK_STDIN, 'replace', { noColor: true });
    const lines = output.split('\n').filter(Boolean);
    expect(lines[0]).toContain('project');
  });

  it('inline mode produces single line', () => {
    const output = renderStatusline(MOCK_STDIN, 'inline', { noColor: true });
    const lines = output.split('\n').filter(Boolean);
    expect(lines.length).toBe(1);
  });

  it('add mode produces single line (meter data only)', () => {
    const output = renderStatusline(MOCK_STDIN, 'add', { noColor: true });
    const lines = output.split('\n').filter(Boolean);
    expect(lines.length).toBe(1);
  });

  it('output contains cost info', () => {
    const output = renderStatusline(MOCK_STDIN, 'inline', { noColor: true });
    expect(output).toContain('$');
  });

  it('handles null current_usage gracefully', () => {
    const data = { ...MOCK_STDIN, context_window: { ...MOCK_STDIN.context_window, current_usage: null } };
    const output = renderStatusline(data, 'replace', { noColor: true });
    expect(output.length).toBeGreaterThan(0);
  });
});
