import { ConfigManager } from '../../src/core/config-manager.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('ConfigManager', () => {
  let tempDir: string;
  let cm: ConfigManager;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'claude-meter-test-'));
    cm = new ConfigManager(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns defaults when no config exists', () => {
    const config = cm.load();
    expect(config.defaultCommand).toBe('this-month');
    expect(config.logPaths).toEqual([]);
    expect(config.statusline.format).toBe('cost');
    expect(config.statusline.refreshCache).toBe(300);
    expect(config.pricing.source).toBe('bundled');
    expect(config.formatting.numberFormat).toBe('short');
  });

  it('saves and loads config', () => {
    cm.set('defaultCommand', 'today');
    const config = cm.load();
    expect(config.defaultCommand).toBe('today');
  });

  it('saves logPaths', () => {
    cm.set('logPaths', ['/some/path']);
    const config = cm.load();
    expect(config.logPaths).toEqual(['/some/path']);
  });

  it('resets config to defaults', () => {
    cm.set('defaultCommand', 'today');
    cm.reset();
    const config = cm.load();
    expect(config.defaultCommand).toBe('this-month');
  });

  it('merges nested keys with dot notation', () => {
    cm.set('statusline.format', 'full');
    const config = cm.load();
    expect(config.statusline.format).toBe('full');
    // Other nested keys should remain
    expect(config.statusline.refreshCache).toBe(300);
  });

  it('handles corrupt config gracefully', () => {
    writeFileSync(join(tempDir, 'config.json'), 'NOT JSON', 'utf-8');
    const config = cm.load();
    expect(config.defaultCommand).toBe('this-month'); // falls back to defaults
  });

  it('getConfigDir returns the config directory', () => {
    expect(cm.getConfigDir()).toBe(tempDir);
  });

  describe('prototype pollution', () => {
    // `config --set` takes a dotted path from the command line and creates the
    // objects it walks through. Without a guard these keys write onto
    // Object.prototype and every object in the process inherits the change.
    for (const key of ['__proto__.polluted', 'constructor.prototype.polluted', 'a.prototype.polluted']) {
      it(`refuses to set "${key}"`, () => {
        expect(() => cm.set(key, 'yes')).toThrow(/prototype/i);
      });
    }

    it('leaves Object.prototype untouched after a rejected set', () => {
      try {
        cm.set('__proto__.polluted', 'yes');
      } catch {
        // expected
      }
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false);
    });

    it('still sets ordinary nested keys', () => {
      cm.set('statusline.refreshCache', 60);
      expect(cm.load().statusline.refreshCache).toBe(60);
    });
  });
});
