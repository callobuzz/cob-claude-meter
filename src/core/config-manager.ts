import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

export interface StatuslineConfig {
  format: 'cost' | 'tokens+cost' | 'model-split' | 'full';
  refreshCache: number;
}

export interface PricingConfig {
  source: 'bundled' | 'custom';
  overrides: Record<string, Record<string, number>>;
}

export interface FormattingConfig {
  currency: string;
  numberFormat: 'short' | 'full';
}

export interface AppConfig {
  logPaths: string[];
  defaultCommand: string;
  statusline: StatuslineConfig;
  pricing: PricingConfig;
  formatting: FormattingConfig;
}

/** Key names that reach the prototype chain instead of the object itself. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const DEFAULT_CONFIG: AppConfig = {
  logPaths: [],
  defaultCommand: 'this-month',
  statusline: { format: 'cost', refreshCache: 300 },
  pricing: { source: 'bundled', overrides: {} },
  formatting: { currency: 'USD', numberFormat: 'short' },
};

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] !== null &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      typeof target[key] === 'object' &&
      target[key] !== null &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(
        target[key] as Record<string, unknown>,
        source[key] as Record<string, unknown>,
      );
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

export class ConfigManager {
  private readonly configDir: string;
  private readonly configPath: string;

  constructor(configDir?: string) {
    this.configDir = configDir ?? join(homedir(), '.claude-meter');
    this.configPath = join(this.configDir, 'config.json');
  }

  load(): AppConfig {
    if (!existsSync(this.configPath)) {
      return structuredClone(DEFAULT_CONFIG);
    }
    try {
      const raw = readFileSync(this.configPath, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return deepMerge(
        structuredClone(DEFAULT_CONFIG) as unknown as Record<string, unknown>,
        parsed,
      ) as unknown as AppConfig;
    } catch {
      return structuredClone(DEFAULT_CONFIG);
    }
  }

  set(key: string, value: unknown): void {
    const parts = key.split('.');

    // `config --set` walks a dotted path and creates the objects it needs on the
    // way down. Left unguarded that is a prototype-pollution primitive: setting
    // `__proto__.isAdmin` would write onto Object.prototype and change every
    // object in the process, not just this config. No real config key is ever
    // called any of these, so refusing outright costs nothing.
    const unsafe = parts.find((part) => UNSAFE_KEYS.has(part));
    if (unsafe) {
      throw new Error(`Refusing to set "${key}": "${unsafe}" would modify the object prototype`);
    }

    const config = this.load() as unknown as Record<string, unknown>;
    let current = config;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (
        !Object.prototype.hasOwnProperty.call(current, part) ||
        typeof current[part] !== 'object' ||
        current[part] === null
      ) {
        current[part] = {};
      }
      current = current[part] as Record<string, unknown>;
    }
    current[parts[parts.length - 1]] = value;
    this.write(config);
  }

  reset(): void {
    this.write(structuredClone(DEFAULT_CONFIG) as unknown as Record<string, unknown>);
  }

  getConfigDir(): string {
    return this.configDir;
  }

  private write(config: Record<string, unknown>): void {
    if (!existsSync(this.configDir)) {
      mkdirSync(this.configDir, { recursive: true });
    }
    const tmpPath = join(this.configDir, `config.tmp.${randomBytes(4).toString('hex')}`);
    writeFileSync(tmpPath, JSON.stringify(config, null, 2), 'utf-8');
    renameSync(tmpPath, this.configPath);
  }
}
