import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWindowsWrapper } from '../../src/commands/install-statusline-cmd.js';

/**
 * The Windows wrapper is generated JavaScript that embeds whatever statusline
 * command was already configured. Getting the quoting wrong there does not
 * produce a warning — it produces a wrapper that either fails to parse or runs
 * something other than what the user configured.
 */
describe('createWindowsWrapper', () => {
  let dir: string;
  let wrapper: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'meter-wrapper-'));
    wrapper = join(dir, 'wrapper.js');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Reads back the command the generated script would actually execute. */
  function embeddedCommand(): string {
    const script = readFileSync(wrapper, 'utf-8');
    const line = script.split('\n').find((l) => l.startsWith('const line1'));
    if (!line) throw new Error('generated wrapper has no line1');

    // Evaluate the generated file the way node would, but with execSync stubbed
    // so nothing is run. If the quoting is broken this throws a SyntaxError.
    const calls: string[] = [];
    const fn = new Function(
      'require',
      'module',
      `${script.replace(/console\.log\([^)]*\);?/g, '')}`,
    );
    fn(
      (name: string) => {
        if (name === 'child_process') {
          return { execSync: (cmd: string) => { calls.push(cmd); return ''; } };
        }
        if (name === 'fs') return { readFileSync: () => '' };
        throw new Error(`unexpected require: ${name}`);
      },
      { exports: {} },
    );
    return calls[0];
  }

  it('round-trips a plain command', () => {
    createWindowsWrapper('my-statusline --flag', wrapper);
    expect(embeddedCommand()).toBe('my-statusline --flag');
  });

  it('survives a Windows path ending in a backslash', () => {
    // The old escaping replaced only `'`, so this trailing backslash escaped the
    // closing quote and the generated file did not parse at all.
    const cmd = 'C:\\tools\\bin\\';
    createWindowsWrapper(cmd, wrapper);
    expect(embeddedCommand()).toBe(cmd);
  });

  it('survives embedded quotes of both kinds', () => {
    const cmd = `node "C:\\my tools\\sl.js" --name 'it''s'`;
    createWindowsWrapper(cmd, wrapper);
    expect(embeddedCommand()).toBe(cmd);
  });

  it('does not let a crafted command close the string and inject code', () => {
    // Reaches for: '); require('fs').writeFileSync('pwned'); ('
    const cmd = `x'); throw new Error('injected'); ('`;
    createWindowsWrapper(cmd, wrapper);
    expect(embeddedCommand()).toBe(cmd);
  });

  it('survives a newline in the command', () => {
    const cmd = 'first --a\nsecond --b';
    createWindowsWrapper(cmd, wrapper);
    expect(embeddedCommand()).toBe(cmd);
  });
});
