import { ConfigManager } from '../core/config-manager.js';

export async function runConfigCommand(opts: {
  set?: string;
  reset?: boolean;
}): Promise<string> {
  const mgr = new ConfigManager();

  if (opts.reset) {
    mgr.reset();
    return 'Config reset to defaults.';
  }

  if (opts.set) {
    const eqIndex = opts.set.indexOf('=');
    if (eqIndex === -1) {
      return 'Error: --set requires key=value format (e.g. --set defaultCommand=today)';
    }
    const key = opts.set.slice(0, eqIndex);
    const rawValue = opts.set.slice(eqIndex + 1);

    let value: unknown;
    try {
      value = JSON.parse(rawValue);
    } catch {
      value = rawValue;
    }

    mgr.set(key, value);
    return `Set ${key} = ${JSON.stringify(value)}`;
  }

  // Show current config
  const config = mgr.load();
  return JSON.stringify(config, null, 2);
}
