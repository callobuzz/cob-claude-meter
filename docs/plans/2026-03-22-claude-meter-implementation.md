# Claude Meter Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a cross-platform Node.js CLI tool that parses Claude Code JSONL logs and reports token usage + cost estimates, with Claude Code statusline integration.

**Architecture:** Single npm package (`@callobuzz/claude-meter`) using TypeScript compiled to JS. Core modules handle log scanning (Node.js readline streams), token aggregation (per-model grouping), pricing (bundled JSON), and formatting (K/M/B numbers, box-drawing CLI output). Commands use `commander`, interactive prompts use `inquirer`, colors use `chalk`.

**Tech Stack:** TypeScript, Node.js >= 18, commander, chalk, inquirer

**Design doc:** `docs/plans/2026-03-22-claude-meter-design.md`

---

## Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `src/index.ts` (placeholder)
- Create: `src/cli.ts` (placeholder)

**Step 1: Initialize package.json**

```json
{
  "name": "@callobuzz/claude-meter",
  "version": "0.1.0",
  "description": "CLI tool for Claude Code token usage tracking and cost estimation",
  "main": "dist/index.js",
  "bin": {
    "claude-meter": "dist/cli.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "start": "node dist/cli.js",
    "test": "node --experimental-vm-modules node_modules/.bin/jest",
    "lint": "eslint src/"
  },
  "engines": {
    "node": ">=18"
  },
  "files": [
    "dist/",
    "data/"
  ],
  "keywords": [
    "claude", "claude-code", "token-usage", "cost-estimation",
    "cli", "anthropic", "statusline", "meter"
  ],
  "author": "SV",
  "license": "MIT",
  "dependencies": {
    "chalk": "^5.3.0",
    "commander": "^12.1.0",
    "inquirer": "^9.2.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "@types/inquirer": "^9.0.0",
    "jest": "^29.7.0",
    "@types/jest": "^29.5.0",
    "ts-jest": "^29.1.0",
    "typescript": "^5.4.0"
  }
}
```

**Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

**Step 3: Create .gitignore**

```
node_modules/
dist/
*.js.map
.claude-meter/
*.tgz
```

**Step 4: Create placeholder entry files**

`src/index.ts`:
```typescript
export { version } from '../package.json';
```

`src/cli.ts`:
```typescript
#!/usr/bin/env node
console.log('claude-meter v0.1.0');
```

**Step 5: Install dependencies and verify build**

Run: `npm install && npm run build`
Expected: Compiles to `dist/` without errors

**Step 6: Verify CLI runs**

Run: `node dist/cli.js`
Expected: `claude-meter v0.1.0`

**Step 7: Create jest.config.ts**

```typescript
export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
};
```

**Step 8: Commit**

```bash
git init
git add package.json tsconfig.json .gitignore src/index.ts src/cli.ts jest.config.ts
git commit -m "chore: scaffold project with TypeScript, commander, chalk, jest"
```

---

## Task 2: Core — Formatter Module

**Files:**
- Create: `src/core/formatter.ts`
- Create: `tests/core/formatter.test.ts`

**Step 1: Write failing tests**

```typescript
// tests/core/formatter.test.ts
import { formatTokens, formatCost, formatPercentage } from '../src/core/formatter';

describe('formatTokens', () => {
  it('formats numbers under 1000 as-is', () => {
    expect(formatTokens(500)).toBe('500');
  });

  it('formats thousands as K', () => {
    expect(formatTokens(1234)).toBe('1.2K');
  });

  it('formats millions as M', () => {
    expect(formatTokens(1234567)).toBe('1.2M');
  });

  it('formats billions as B', () => {
    expect(formatTokens(1234567890)).toBe('1.2B');
  });

  it('handles zero', () => {
    expect(formatTokens(0)).toBe('0');
  });

  it('formats exact thousands cleanly', () => {
    expect(formatTokens(1000)).toBe('1.0K');
  });

  it('formats full numbers when mode is full', () => {
    expect(formatTokens(1234567, 'full')).toBe('1,234,567');
  });
});

describe('formatCost', () => {
  it('formats small costs with 2 decimals', () => {
    expect(formatCost(29.48)).toBe('$29.48');
  });

  it('formats costs over 1000 with K suffix', () => {
    expect(formatCost(1243.50)).toBe('$1.2K');
  });

  it('formats zero cost', () => {
    expect(formatCost(0)).toBe('$0.00');
  });

  it('formats costs under a dollar', () => {
    expect(formatCost(0.42)).toBe('$0.42');
  });
});

describe('formatPercentage', () => {
  it('formats whole percentages', () => {
    expect(formatPercentage(92.3)).toBe('92.3%');
  });

  it('formats zero', () => {
    expect(formatPercentage(0)).toBe('0%');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx jest tests/core/formatter.test.ts`
Expected: FAIL — cannot find module

**Step 3: Implement formatter**

```typescript
// src/core/formatter.ts
export type NumberFormat = 'short' | 'full';

export function formatTokens(n: number, mode: NumberFormat = 'short'): string {
  if (mode === 'full') {
    return n.toLocaleString('en-US');
  }
  if (n === 0) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}K`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${(n / 1_000_000_000).toFixed(1)}B`;
}

export function formatCost(n: number): string {
  if (n >= 1000) {
    return `$${(n / 1000).toFixed(1)}K`;
  }
  return `$${n.toFixed(2)}`;
}

export function formatPercentage(n: number): string {
  if (n === 0) return '0%';
  return `${n.toFixed(1)}%`;
}
```

**Step 4: Run tests to verify they pass**

Run: `npx jest tests/core/formatter.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/core/formatter.ts tests/core/formatter.test.ts
git commit -m "feat: add formatter module with K/M/B number formatting"
```

---

## Task 3: Core — Pricing Module

**Files:**
- Create: `data/pricing.json`
- Create: `src/core/pricing.ts`
- Create: `tests/core/pricing.test.ts`

**Step 1: Create bundled pricing.json**

```json
{
  "version": "2026-03-22",
  "source": "https://platform.claude.com/docs/en/about-claude/pricing",
  "rates_per_million_tokens": {
    "claude-opus-4-6": {
      "input": 5.00,
      "output": 25.00,
      "cache_write_5m": 6.25,
      "cache_write_1h": 10.00,
      "cache_read": 0.50
    },
    "claude-opus-4-5": {
      "input": 5.00,
      "output": 25.00,
      "cache_write_5m": 6.25,
      "cache_write_1h": 10.00,
      "cache_read": 0.50
    },
    "claude-opus-4-1": {
      "input": 15.00,
      "output": 75.00,
      "cache_write_5m": 18.75,
      "cache_write_1h": 30.00,
      "cache_read": 1.50
    },
    "claude-opus-4": {
      "input": 15.00,
      "output": 75.00,
      "cache_write_5m": 18.75,
      "cache_write_1h": 30.00,
      "cache_read": 1.50
    },
    "claude-sonnet-4-6": {
      "input": 3.00,
      "output": 15.00,
      "cache_write_5m": 3.75,
      "cache_write_1h": 6.00,
      "cache_read": 0.30
    },
    "claude-sonnet-4-5": {
      "input": 3.00,
      "output": 15.00,
      "cache_write_5m": 3.75,
      "cache_write_1h": 6.00,
      "cache_read": 0.30
    },
    "claude-sonnet-4": {
      "input": 3.00,
      "output": 15.00,
      "cache_write_5m": 3.75,
      "cache_write_1h": 6.00,
      "cache_read": 0.30
    },
    "claude-haiku-4-5": {
      "input": 1.00,
      "output": 5.00,
      "cache_write_5m": 1.25,
      "cache_write_1h": 2.00,
      "cache_read": 0.10
    },
    "claude-haiku-3-5": {
      "input": 0.80,
      "output": 4.00,
      "cache_write_5m": 1.00,
      "cache_write_1h": 1.60,
      "cache_read": 0.08
    },
    "claude-haiku-3": {
      "input": 0.25,
      "output": 1.25,
      "cache_write_5m": 0.30,
      "cache_write_1h": 0.50,
      "cache_read": 0.03
    }
  }
}
```

**Step 2: Write failing tests**

```typescript
// tests/core/pricing.test.ts
import { resolveModelPricing, computeCost, ModelRates } from '../src/core/pricing';

describe('resolveModelPricing', () => {
  it('resolves exact model ID', () => {
    const rates = resolveModelPricing('claude-opus-4-6');
    expect(rates.input).toBe(5.00);
    expect(rates.output).toBe(25.00);
  });

  it('resolves model ID with date suffix', () => {
    const rates = resolveModelPricing('claude-opus-4-5-20251101');
    expect(rates.input).toBe(5.00);
  });

  it('resolves haiku with date suffix', () => {
    const rates = resolveModelPricing('claude-haiku-4-5-20251001');
    expect(rates.input).toBe(1.00);
  });

  it('returns fallback for unknown model with warning', () => {
    const rates = resolveModelPricing('claude-unknown-99');
    expect(rates.input).toBe(5.00); // opus-4-6 fallback
    expect(rates._fallback).toBe(true);
  });
});

describe('computeCost', () => {
  it('computes cost from tokens and rate', () => {
    // 5M tokens at $5/MTok = $25
    expect(computeCost(5_000_000, 5.00)).toBeCloseTo(25.00, 2);
  });

  it('handles zero tokens', () => {
    expect(computeCost(0, 5.00)).toBe(0);
  });
});
```

**Step 3: Run tests to verify they fail**

Run: `npx jest tests/core/pricing.test.ts`
Expected: FAIL

**Step 4: Implement pricing module**

```typescript
// src/core/pricing.ts
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ModelRates {
  input: number;
  output: number;
  cache_write_5m: number;
  cache_write_1h: number;
  cache_read: number;
  _fallback?: boolean;
}

interface PricingData {
  version: string;
  source: string;
  rates_per_million_tokens: Record<string, ModelRates>;
}

let cachedPricing: PricingData | null = null;

function loadBundledPricing(): PricingData {
  if (cachedPricing) return cachedPricing;
  const pricingPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'pricing.json');
  cachedPricing = JSON.parse(readFileSync(pricingPath, 'utf-8'));
  return cachedPricing!;
}

function stripDateSuffix(modelId: string): string {
  // claude-opus-4-5-20251101 → claude-opus-4-5
  return modelId.replace(/-\d{8}$/, '');
}

const FALLBACK_MODEL = 'claude-opus-4-6';

export function resolveModelPricing(
  modelId: string,
  userOverrides?: Record<string, Partial<ModelRates>>
): ModelRates {
  const pricing = loadBundledPricing();
  const rates = pricing.rates_per_million_tokens;

  // Check user overrides first
  if (userOverrides?.[modelId]) {
    return { ...rates[FALLBACK_MODEL], ...userOverrides[modelId] } as ModelRates;
  }

  // Exact match
  if (rates[modelId]) return { ...rates[modelId] };

  // Strip date suffix and try again
  const stripped = stripDateSuffix(modelId);
  if (rates[stripped]) return { ...rates[stripped] };

  // Fallback to opus-4-6
  return { ...rates[FALLBACK_MODEL], _fallback: true };
}

export function computeCost(tokens: number, ratePerMillion: number): number {
  return (tokens / 1_000_000) * ratePerMillion;
}

export function getPricingVersion(): string {
  return loadBundledPricing().version;
}

export function getAllModelIds(): string[] {
  return Object.keys(loadBundledPricing().rates_per_million_tokens);
}
```

**Step 5: Run tests**

Run: `npx jest tests/core/pricing.test.ts`
Expected: All PASS

**Step 6: Commit**

```bash
git add data/pricing.json src/core/pricing.ts tests/core/pricing.test.ts
git commit -m "feat: add pricing module with bundled rates and model ID matching"
```

---

## Task 4: Core — Config Manager

**Files:**
- Create: `src/core/config-manager.ts`
- Create: `tests/core/config-manager.test.ts`

**Step 1: Write failing tests**

```typescript
// tests/core/config-manager.test.ts
import { ConfigManager, AppConfig } from '../src/core/config-manager';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
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

  it('merges nested keys', () => {
    cm.set('statusline.format', 'full');
    const config = cm.load();
    expect(config.statusline.format).toBe('full');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx jest tests/core/config-manager.test.ts`
Expected: FAIL

**Step 3: Implement config manager**

```typescript
// src/core/config-manager.ts
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

const DEFAULT_CONFIG: AppConfig = {
  logPaths: [],
  defaultCommand: 'this-month',
  statusline: {
    format: 'cost',
    refreshCache: 300,
  },
  pricing: {
    source: 'bundled',
    overrides: {},
  },
  formatting: {
    currency: 'USD',
    numberFormat: 'short',
  },
};

export class ConfigManager {
  private configDir: string;
  private configPath: string;

  constructor(configDir?: string) {
    this.configDir = configDir ?? join(homedir(), '.claude-meter');
    this.configPath = join(this.configDir, 'config.json');
  }

  getConfigDir(): string {
    return this.configDir;
  }

  load(): AppConfig {
    if (!existsSync(this.configPath)) {
      return { ...DEFAULT_CONFIG };
    }
    try {
      const raw = JSON.parse(readFileSync(this.configPath, 'utf-8'));
      return this.merge(DEFAULT_CONFIG, raw);
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  set(key: string, value: unknown): void {
    const config = this.load();
    const keys = key.split('.');
    let target: Record<string, unknown> = config as unknown as Record<string, unknown>;
    for (let i = 0; i < keys.length - 1; i++) {
      if (typeof target[keys[i]] !== 'object' || target[keys[i]] === null) {
        target[keys[i]] = {};
      }
      target = target[keys[i]] as Record<string, unknown>;
    }
    target[keys[keys.length - 1]] = value;
    this.save(config);
  }

  reset(): void {
    this.save(DEFAULT_CONFIG);
  }

  private save(config: AppConfig): void {
    if (!existsSync(this.configDir)) {
      mkdirSync(this.configDir, { recursive: true });
    }
    // Atomic write: temp file → rename
    const tmpPath = join(this.configDir, `config-${randomBytes(4).toString('hex')}.tmp`);
    writeFileSync(tmpPath, JSON.stringify(config, null, 2), 'utf-8');
    renameSync(tmpPath, this.configPath);
  }

  private merge(defaults: Record<string, unknown>, overrides: Record<string, unknown>): AppConfig {
    const result = { ...defaults };
    for (const key of Object.keys(overrides)) {
      if (
        typeof defaults[key] === 'object' &&
        defaults[key] !== null &&
        !Array.isArray(defaults[key]) &&
        typeof overrides[key] === 'object' &&
        overrides[key] !== null &&
        !Array.isArray(overrides[key])
      ) {
        result[key] = this.merge(
          defaults[key] as Record<string, unknown>,
          overrides[key] as Record<string, unknown>,
        );
      } else {
        result[key] = overrides[key];
      }
    }
    return result as unknown as AppConfig;
  }
}
```

**Step 4: Run tests**

Run: `npx jest tests/core/config-manager.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/core/config-manager.ts tests/core/config-manager.test.ts
git commit -m "feat: add config manager with defaults, set, reset, atomic writes"
```

---

## Task 5: Core — Path Resolver

**Files:**
- Create: `src/core/path-resolver.ts`
- Create: `tests/core/path-resolver.test.ts`

**Step 1: Write failing tests**

```typescript
// tests/core/path-resolver.test.ts
import { getDefaultPaths, validatePath } from '../src/core/path-resolver';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('getDefaultPaths', () => {
  it('returns an array of paths', () => {
    const paths = getDefaultPaths();
    expect(Array.isArray(paths)).toBe(true);
    expect(paths.length).toBeGreaterThan(0);
  });

  it('all paths are absolute', () => {
    const paths = getDefaultPaths();
    for (const p of paths) {
      expect(p).toMatch(/^[A-Z]:\\|^\//); // Windows or Unix absolute
    }
  });
});

describe('validatePath', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'claude-meter-path-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns valid result for dir with jsonl files', () => {
    writeFileSync(join(tempDir, 'test.jsonl'), '{}');
    const result = validatePath(tempDir);
    expect(result.valid).toBe(true);
    expect(result.fileCount).toBe(1);
  });

  it('returns invalid for non-existent dir', () => {
    const result = validatePath('/nonexistent/path/12345');
    expect(result.valid).toBe(false);
  });

  it('returns valid but zero files for empty dir', () => {
    const result = validatePath(tempDir);
    expect(result.valid).toBe(true);
    expect(result.fileCount).toBe(0);
  });

  it('counts jsonl files recursively', () => {
    const sub = join(tempDir, 'sub');
    mkdirSync(sub);
    writeFileSync(join(tempDir, 'a.jsonl'), '{}');
    writeFileSync(join(sub, 'b.jsonl'), '{}');
    const result = validatePath(tempDir);
    expect(result.fileCount).toBe(2);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx jest tests/core/path-resolver.test.ts`
Expected: FAIL

**Step 3: Implement path resolver**

```typescript
// src/core/path-resolver.ts
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';

export interface PathValidation {
  valid: boolean;
  fileCount: number;
  error?: string;
}

export function getDefaultPaths(): string[] {
  const home = homedir();
  const paths: string[] = [];
  const os = platform();

  // Common across all platforms
  paths.push(join(home, '.claude', 'projects'));

  if (os === 'win32') {
    const appData = process.env.APPDATA;
    if (appData) {
      paths.push(join(appData, 'claude', 'projects'));
    }
  } else if (os === 'darwin') {
    paths.push(join(home, 'Library', 'Application Support', 'claude', 'projects'));
  } else {
    // Linux
    paths.push(join(home, '.config', 'claude', 'projects'));
  }

  return paths;
}

export function discoverLogPaths(): string[] {
  const defaults = getDefaultPaths();
  return defaults.filter(p => existsSync(p));
}

export function validatePath(dirPath: string): PathValidation {
  if (!existsSync(dirPath)) {
    return { valid: false, fileCount: 0, error: 'Path does not exist' };
  }

  try {
    const stat = statSync(dirPath);
    if (!stat.isDirectory()) {
      return { valid: false, fileCount: 0, error: 'Path is not a directory' };
    }
  } catch {
    return { valid: false, fileCount: 0, error: 'Cannot access path' };
  }

  const fileCount = countJsonlFiles(dirPath);
  return { valid: true, fileCount };
}

function countJsonlFiles(dirPath: string): number {
  let count = 0;
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        count += countJsonlFiles(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        count++;
      }
    }
  } catch {
    // Permission denied, skip
  }
  return count;
}
```

**Step 4: Run tests**

Run: `npx jest tests/core/path-resolver.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/core/path-resolver.ts tests/core/path-resolver.test.ts
git commit -m "feat: add cross-platform path resolver with auto-discovery and validation"
```

---

## Task 6: Core — Scanner Module

**Files:**
- Create: `src/core/scanner.ts`
- Create: `tests/core/scanner.test.ts`
- Create: `tests/fixtures/sample.jsonl` (test fixture)

**Step 1: Create test fixture**

```jsonl
{"type":"assistant","message":{"model":"claude-opus-4-6","usage":{"input_tokens":100,"output_tokens":200,"cache_read_input_tokens":5000,"cache_creation_input_tokens":3000,"cache_creation":{"ephemeral_5m_input_tokens":1000,"ephemeral_1h_input_tokens":2000},"server_tool_use":{"web_search_requests":1,"web_fetch_requests":0}}},"timestamp":"2026-03-22T10:00:00Z","sessionId":"sess-001"}
{"type":"assistant","message":{"model":"claude-haiku-4-5-20251001","usage":{"input_tokens":50,"output_tokens":80,"cache_read_input_tokens":1000,"cache_creation_input_tokens":500,"cache_creation":{"ephemeral_5m_input_tokens":200,"ephemeral_1h_input_tokens":300},"server_tool_use":{"web_search_requests":0,"web_fetch_requests":1}}},"timestamp":"2026-03-22T11:00:00Z","sessionId":"sess-001"}
{"type":"user","message":{"role":"user","content":"hello"},"timestamp":"2026-03-22T10:00:01Z"}
{"type":"assistant","message":{"model":"claude-opus-4-6","usage":{"input_tokens":150,"output_tokens":300,"cache_read_input_tokens":8000,"cache_creation_input_tokens":4000,"cache_creation":{"ephemeral_5m_input_tokens":1500,"ephemeral_1h_input_tokens":2500},"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0}}},"timestamp":"2026-03-21T09:00:00Z","sessionId":"sess-002"}
INVALID JSON LINE
{"type":"assistant","message":{"no_usage_field":true},"timestamp":"2026-03-22T10:00:00Z"}
```

**Step 2: Write failing tests**

```typescript
// tests/core/scanner.test.ts
import { scanFile, LogEntry } from '../src/core/scanner';
import { join } from 'node:path';

const FIXTURE_PATH = join(__dirname, 'fixtures', 'sample.jsonl');

describe('scanFile', () => {
  it('parses valid assistant entries with usage', async () => {
    const entries: LogEntry[] = [];
    await scanFile(FIXTURE_PATH, (entry) => entries.push(entry));
    expect(entries).toHaveLength(3);
  });

  it('extracts correct token fields', async () => {
    const entries: LogEntry[] = [];
    await scanFile(FIXTURE_PATH, (entry) => entries.push(entry));
    const first = entries[0];
    expect(first.input_tokens).toBe(100);
    expect(first.output_tokens).toBe(200);
    expect(first.cache_read_input_tokens).toBe(5000);
    expect(first.cache_creation_input_tokens).toBe(3000);
    expect(first.cache_5m_input_tokens).toBe(1000);
    expect(first.cache_1h_input_tokens).toBe(2000);
  });

  it('extracts model', async () => {
    const entries: LogEntry[] = [];
    await scanFile(FIXTURE_PATH, (entry) => entries.push(entry));
    expect(entries[0].model).toBe('claude-opus-4-6');
    expect(entries[1].model).toBe('claude-haiku-4-5-20251001');
  });

  it('extracts timestamp as Date', async () => {
    const entries: LogEntry[] = [];
    await scanFile(FIXTURE_PATH, (entry) => entries.push(entry));
    expect(entries[0].timestamp).toBeInstanceOf(Date);
  });

  it('skips invalid JSON lines', async () => {
    const entries: LogEntry[] = [];
    const stats = await scanFile(FIXTURE_PATH, (entry) => entries.push(entry));
    expect(stats.skippedLines).toBeGreaterThan(0);
  });

  it('skips entries without usage', async () => {
    const entries: LogEntry[] = [];
    await scanFile(FIXTURE_PATH, (entry) => entries.push(entry));
    // Only 3 valid assistant entries with usage
    expect(entries).toHaveLength(3);
  });

  it('extracts web search/fetch counts', async () => {
    const entries: LogEntry[] = [];
    await scanFile(FIXTURE_PATH, (entry) => entries.push(entry));
    expect(entries[0].web_searches).toBe(1);
    expect(entries[1].web_fetches).toBe(1);
  });

  it('extracts sessionId', async () => {
    const entries: LogEntry[] = [];
    await scanFile(FIXTURE_PATH, (entry) => entries.push(entry));
    expect(entries[0].sessionId).toBe('sess-001');
  });
});
```

**Step 3: Run tests to verify they fail**

Run: `npx jest tests/core/scanner.test.ts`
Expected: FAIL

**Step 4: Implement scanner**

```typescript
// src/core/scanner.ts
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

export interface LogEntry {
  timestamp: Date;
  model: string;
  sessionId: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  cache_5m_input_tokens: number;
  cache_1h_input_tokens: number;
  web_searches: number;
  web_fetches: number;
}

export interface ScanStats {
  linesRead: number;
  skippedLines: number;
  entriesMatched: number;
}

export async function scanFile(
  filePath: string,
  onEntry: (entry: LogEntry) => void,
  dateFilter?: { start: Date; end: Date },
): Promise<ScanStats> {
  const stats: ScanStats = { linesRead: 0, skippedLines: 0, entriesMatched: 0 };

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    stats.linesRead++;
    try {
      const json = JSON.parse(line);

      if (json.type !== 'assistant') continue;
      if (!json.message?.usage) continue;
      if (!json.timestamp) continue;

      const ts = new Date(json.timestamp);
      if (isNaN(ts.getTime())) continue;

      if (dateFilter) {
        if (ts < dateFilter.start || ts > dateFilter.end) continue;
      }

      const usage = json.message.usage;
      const cacheCreation = usage.cache_creation ?? {};
      const serverTools = usage.server_tool_use ?? {};

      const entry: LogEntry = {
        timestamp: ts,
        model: json.message.model ?? 'unknown',
        sessionId: json.sessionId ?? 'unknown',
        input_tokens: usage.input_tokens ?? 0,
        output_tokens: usage.output_tokens ?? 0,
        cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
        cache_5m_input_tokens: cacheCreation.ephemeral_5m_input_tokens ?? 0,
        cache_1h_input_tokens: cacheCreation.ephemeral_1h_input_tokens ?? 0,
        web_searches: serverTools.web_search_requests ?? 0,
        web_fetches: serverTools.web_fetch_requests ?? 0,
      };

      stats.entriesMatched++;
      onEntry(entry);
    } catch {
      stats.skippedLines++;
    }
  }

  return stats;
}
```

Note: The test fixture file must be created at `tests/fixtures/sample.jsonl` (copy the JSONL content from Step 1). Make sure each JSON entry is on a single line.

**Step 5: Run tests**

Run: `npx jest tests/core/scanner.test.ts`
Expected: All PASS

**Step 6: Commit**

```bash
git add src/core/scanner.ts tests/core/scanner.test.ts tests/fixtures/sample.jsonl
git commit -m "feat: add streaming JSONL scanner with field extraction and date filtering"
```

---

## Task 7: Core — Aggregator Module

**Files:**
- Create: `src/core/aggregator.ts`
- Create: `tests/core/aggregator.test.ts`

**Step 1: Write failing tests**

```typescript
// tests/core/aggregator.test.ts
import { Aggregator } from '../src/core/aggregator';
import { LogEntry } from '../src/core/scanner';

function makeEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    timestamp: new Date('2026-03-22T10:00:00Z'),
    model: 'claude-opus-4-6',
    sessionId: 'sess-001',
    input_tokens: 100,
    output_tokens: 200,
    cache_read_input_tokens: 5000,
    cache_creation_input_tokens: 3000,
    cache_5m_input_tokens: 1000,
    cache_1h_input_tokens: 2000,
    web_searches: 0,
    web_fetches: 0,
    ...overrides,
  };
}

describe('Aggregator', () => {
  it('aggregates totals from multiple entries', () => {
    const agg = new Aggregator();
    agg.add(makeEntry());
    agg.add(makeEntry());
    const result = agg.getResult('today', new Date(), new Date());
    expect(result.totals.input_tokens).toBe(200);
    expect(result.totals.output_tokens).toBe(400);
    expect(result.totals.entries_matched).toBe(2);
  });

  it('groups by model', () => {
    const agg = new Aggregator();
    agg.add(makeEntry({ model: 'claude-opus-4-6' }));
    agg.add(makeEntry({ model: 'claude-haiku-4-5-20251001' }));
    const result = agg.getResult('today', new Date(), new Date());
    expect(Object.keys(result.by_model)).toHaveLength(2);
    expect(result.by_model['claude-opus-4-6'].input_tokens).toBe(100);
    expect(result.by_model['claude-haiku-4-5-20251001'].input_tokens).toBe(100);
  });

  it('computes fresh and full totals', () => {
    const agg = new Aggregator();
    agg.add(makeEntry());
    const result = agg.getResult('today', new Date(), new Date());
    expect(result.totals.fresh_total).toBe(300); // 100 + 200
    expect(result.totals.full_total).toBe(8300); // 100 + 200 + 5000 + 3000
  });

  it('tracks unique sessions', () => {
    const agg = new Aggregator();
    agg.add(makeEntry({ sessionId: 'a' }));
    agg.add(makeEntry({ sessionId: 'a' }));
    agg.add(makeEntry({ sessionId: 'b' }));
    const result = agg.getResult('today', new Date(), new Date());
    expect(result.totals.sessions).toBe(2);
  });

  it('aggregates web search/fetch counts', () => {
    const agg = new Aggregator();
    agg.add(makeEntry({ web_searches: 3, web_fetches: 1 }));
    agg.add(makeEntry({ web_searches: 2, web_fetches: 4 }));
    const result = agg.getResult('today', new Date(), new Date());
    expect(result.totals.web_searches).toBe(5);
    expect(result.totals.web_fetches).toBe(5);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx jest tests/core/aggregator.test.ts`
Expected: FAIL

**Step 3: Implement aggregator**

```typescript
// src/core/aggregator.ts
import { LogEntry } from './scanner.js';

export interface TokenTotals {
  entries_matched: number;
  files_scanned: number;
  sessions: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  cache_5m_input_tokens: number;
  cache_1h_input_tokens: number;
  fresh_total: number;
  full_total: number;
  web_searches: number;
  web_fetches: number;
}

export interface ModelTokens {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  cache_5m_input_tokens: number;
  cache_1h_input_tokens: number;
  entries: number;
}

export interface AggregationResult {
  period: { label: string; start: string; end: string };
  totals: TokenTotals;
  by_model: Record<string, ModelTokens>;
}

function emptyTotals(): TokenTotals {
  return {
    entries_matched: 0,
    files_scanned: 0,
    sessions: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_5m_input_tokens: 0,
    cache_1h_input_tokens: 0,
    fresh_total: 0,
    full_total: 0,
    web_searches: 0,
    web_fetches: 0,
  };
}

function emptyModelTokens(): ModelTokens {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_5m_input_tokens: 0,
    cache_1h_input_tokens: 0,
    entries: 0,
  };
}

export class Aggregator {
  private totals: TokenTotals = emptyTotals();
  private models: Record<string, ModelTokens> = {};
  private sessionIds: Set<string> = new Set();

  add(entry: LogEntry): void {
    this.totals.entries_matched++;
    this.totals.input_tokens += entry.input_tokens;
    this.totals.output_tokens += entry.output_tokens;
    this.totals.cache_read_input_tokens += entry.cache_read_input_tokens;
    this.totals.cache_creation_input_tokens += entry.cache_creation_input_tokens;
    this.totals.cache_5m_input_tokens += entry.cache_5m_input_tokens;
    this.totals.cache_1h_input_tokens += entry.cache_1h_input_tokens;
    this.totals.web_searches += entry.web_searches;
    this.totals.web_fetches += entry.web_fetches;

    this.sessionIds.add(entry.sessionId);

    // Per-model
    if (!this.models[entry.model]) {
      this.models[entry.model] = emptyModelTokens();
    }
    const m = this.models[entry.model];
    m.input_tokens += entry.input_tokens;
    m.output_tokens += entry.output_tokens;
    m.cache_read_input_tokens += entry.cache_read_input_tokens;
    m.cache_creation_input_tokens += entry.cache_creation_input_tokens;
    m.cache_5m_input_tokens += entry.cache_5m_input_tokens;
    m.cache_1h_input_tokens += entry.cache_1h_input_tokens;
    m.entries++;
  }

  setFilesScanned(count: number): void {
    this.totals.files_scanned = count;
  }

  getResult(label: string, start: Date, end: Date): AggregationResult {
    this.totals.sessions = this.sessionIds.size;
    this.totals.fresh_total = this.totals.input_tokens + this.totals.output_tokens;
    this.totals.full_total =
      this.totals.input_tokens +
      this.totals.output_tokens +
      this.totals.cache_read_input_tokens +
      this.totals.cache_creation_input_tokens;

    return {
      period: {
        label,
        start: start.toISOString(),
        end: end.toISOString(),
      },
      totals: { ...this.totals },
      by_model: { ...this.models },
    };
  }
}
```

**Step 4: Run tests**

Run: `npx jest tests/core/aggregator.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/core/aggregator.ts tests/core/aggregator.test.ts
git commit -m "feat: add aggregator with per-model grouping and session tracking"
```

---

## Task 8: Core — Cache Manager

**Files:**
- Create: `src/core/cache-manager.ts`
- Create: `tests/core/cache-manager.test.ts`

**Step 1: Write failing tests**

```typescript
// tests/core/cache-manager.test.ts
import { CacheManager } from '../src/core/cache-manager';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('CacheManager', () => {
  let tempDir: string;
  let cache: CacheManager;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'claude-meter-cache-'));
    cache = new CacheManager(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns null when no cache exists', () => {
    expect(cache.read()).toBeNull();
  });

  it('writes and reads cache data', () => {
    const data = { today: { tokens: 1000, cost: 5.00 } };
    cache.write(data);
    const result = cache.read();
    expect(result?.data).toEqual(data);
  });

  it('reports cache as stale after TTL', () => {
    const data = { today: { tokens: 1000 } };
    cache.write(data);
    expect(cache.isStale(0)).toBe(true); // 0 second TTL = always stale
  });

  it('reports cache as fresh within TTL', () => {
    const data = { today: { tokens: 1000 } };
    cache.write(data);
    expect(cache.isStale(300)).toBe(false); // 5 min TTL
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx jest tests/core/cache-manager.test.ts`
Expected: FAIL

**Step 3: Implement cache manager**

```typescript
// src/core/cache-manager.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface CacheEntry {
  timestamp: string;
  data: unknown;
}

export class CacheManager {
  private cachePath: string;
  private cacheDir: string;

  constructor(cacheDir: string) {
    this.cacheDir = cacheDir;
    this.cachePath = join(cacheDir, 'cache.json');
  }

  read(): CacheEntry | null {
    if (!existsSync(this.cachePath)) return null;
    try {
      return JSON.parse(readFileSync(this.cachePath, 'utf-8'));
    } catch {
      return null;
    }
  }

  write(data: unknown): void {
    if (!existsSync(this.cacheDir)) {
      mkdirSync(this.cacheDir, { recursive: true });
    }
    const entry: CacheEntry = {
      timestamp: new Date().toISOString(),
      data,
    };
    // Atomic write
    const tmpPath = join(this.cacheDir, `cache-${randomBytes(4).toString('hex')}.tmp`);
    writeFileSync(tmpPath, JSON.stringify(entry), 'utf-8');
    renameSync(tmpPath, this.cachePath);
  }

  isStale(ttlSeconds: number): boolean {
    const entry = this.read();
    if (!entry) return true;
    const age = (Date.now() - new Date(entry.timestamp).getTime()) / 1000;
    return age > ttlSeconds;
  }
}
```

**Step 4: Run tests**

Run: `npx jest tests/core/cache-manager.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/core/cache-manager.ts tests/core/cache-manager.test.ts
git commit -m "feat: add cache manager with TTL and atomic writes"
```

---

## Task 9: Core — Cost Calculator (integrates aggregator + pricing)

**Files:**
- Create: `src/core/cost-calculator.ts`
- Create: `tests/core/cost-calculator.test.ts`

**Step 1: Write failing tests**

```typescript
// tests/core/cost-calculator.test.ts
import { calculateCosts, CostResult } from '../src/core/cost-calculator';
import { AggregationResult } from '../src/core/aggregator';

function makeAggResult(): AggregationResult {
  return {
    period: { label: 'today', start: '', end: '' },
    totals: {
      entries_matched: 2,
      files_scanned: 1,
      sessions: 1,
      input_tokens: 5_000_000,
      output_tokens: 10_000_000,
      cache_read_input_tokens: 100_000_000,
      cache_creation_input_tokens: 50_000_000,
      cache_5m_input_tokens: 20_000_000,
      cache_1h_input_tokens: 30_000_000,
      fresh_total: 15_000_000,
      full_total: 165_000_000,
      web_searches: 5,
      web_fetches: 3,
    },
    by_model: {
      'claude-opus-4-6': {
        input_tokens: 5_000_000,
        output_tokens: 10_000_000,
        cache_read_input_tokens: 100_000_000,
        cache_creation_input_tokens: 50_000_000,
        cache_5m_input_tokens: 20_000_000,
        cache_1h_input_tokens: 30_000_000,
        entries: 2,
      },
    },
  };
}

describe('calculateCosts', () => {
  it('computes total cost correctly', () => {
    const result = calculateCosts(makeAggResult());
    // Input: 5M * $5/M = $25
    expect(result.input).toBeCloseTo(25.00, 1);
    // Output: 10M * $25/M = $250
    expect(result.output).toBeCloseTo(250.00, 1);
    // Cache read: 100M * $0.50/M = $50
    expect(result.cache_read).toBeCloseTo(50.00, 1);
    // Cache 5m: 20M * $6.25/M = $125
    expect(result.cache_creation_5m).toBeCloseTo(125.00, 1);
    // Cache 1h: 30M * $10/M = $300
    expect(result.cache_creation_1h).toBeCloseTo(300.00, 1);
  });

  it('computes per-model costs', () => {
    const result = calculateCosts(makeAggResult());
    expect(result.by_model['claude-opus-4-6']).toBeDefined();
    expect(result.by_model['claude-opus-4-6'].total).toBeGreaterThan(0);
  });

  it('includes pricing metadata', () => {
    const result = calculateCosts(makeAggResult());
    expect(result.pricing_source).toBe('bundled');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx jest tests/core/cost-calculator.test.ts`
Expected: FAIL

**Step 3: Implement cost calculator**

```typescript
// src/core/cost-calculator.ts
import { AggregationResult, ModelTokens } from './aggregator.js';
import { resolveModelPricing, computeCost, getPricingVersion } from './pricing.js';

export interface ModelCost {
  input: number;
  output: number;
  cache_read: number;
  cache_creation_5m: number;
  cache_creation_1h: number;
  total: number;
  fallback: boolean;
}

export interface CostResult {
  input: number;
  output: number;
  cache_read: number;
  cache_creation_5m: number;
  cache_creation_1h: number;
  total: number;
  by_model: Record<string, ModelCost>;
  pricing_source: string;
  pricing_version: string;
}

function computeModelCost(
  tokens: ModelTokens | { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_5m_input_tokens: number; cache_1h_input_tokens: number },
  modelId: string,
  userOverrides?: Record<string, Record<string, number>>,
): ModelCost {
  const rates = resolveModelPricing(modelId, userOverrides as any);
  const input = computeCost(tokens.input_tokens, rates.input);
  const output = computeCost(tokens.output_tokens, rates.output);
  const cache_read = computeCost(tokens.cache_read_input_tokens, rates.cache_read);
  const cache_creation_5m = computeCost(tokens.cache_5m_input_tokens, rates.cache_write_5m);
  const cache_creation_1h = computeCost(tokens.cache_1h_input_tokens, rates.cache_write_1h);
  const total = input + output + cache_read + cache_creation_5m + cache_creation_1h;

  return {
    input,
    output,
    cache_read,
    cache_creation_5m,
    cache_creation_1h,
    total,
    fallback: rates._fallback ?? false,
  };
}

export function calculateCosts(
  aggResult: AggregationResult,
  userOverrides?: Record<string, Record<string, number>>,
): CostResult {
  const byModel: Record<string, ModelCost> = {};
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCache5m = 0;
  let totalCache1h = 0;

  for (const [modelId, tokens] of Object.entries(aggResult.by_model)) {
    const cost = computeModelCost(tokens, modelId, userOverrides);
    byModel[modelId] = cost;
    totalInput += cost.input;
    totalOutput += cost.output;
    totalCacheRead += cost.cache_read;
    totalCache5m += cost.cache_creation_5m;
    totalCache1h += cost.cache_creation_1h;
  }

  return {
    input: totalInput,
    output: totalOutput,
    cache_read: totalCacheRead,
    cache_creation_5m: totalCache5m,
    cache_creation_1h: totalCache1h,
    total: totalInput + totalOutput + totalCacheRead + totalCache5m + totalCache1h,
    by_model: byModel,
    pricing_source: 'bundled',
    pricing_version: getPricingVersion(),
  };
}
```

**Step 4: Run tests**

Run: `npx jest tests/core/cost-calculator.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/core/cost-calculator.ts tests/core/cost-calculator.test.ts
git commit -m "feat: add cost calculator with per-model pricing integration"
```

---

## Task 10: Core — Output Renderer (box-drawing CLI output)

**Files:**
- Create: `src/core/renderer.ts`
- Create: `tests/core/renderer.test.ts`

**Step 1: Write failing tests**

```typescript
// tests/core/renderer.test.ts
import { renderFullReport, renderCompactReport, renderJsonReport } from '../src/core/renderer';
import { AggregationResult } from '../src/core/aggregator';
import { CostResult } from '../src/core/cost-calculator';

// Use the same mock data structures from previous tests
function mockAggResult(): AggregationResult {
  return {
    period: { label: 'this-month', start: '2026-03-01T00:00:00Z', end: '2026-03-22T23:59:59Z' },
    totals: {
      entries_matched: 106461,
      files_scanned: 2568,
      sessions: 847,
      input_tokens: 5896108,
      output_tokens: 11598636,
      cache_read_input_tokens: 8266956710,
      cache_creation_input_tokens: 483414090,
      cache_5m_input_tokens: 201414090,
      cache_1h_input_tokens: 282000000,
      fresh_total: 17494744,
      full_total: 8767865544,
      web_searches: 42,
      web_fetches: 18,
    },
    by_model: {
      'claude-opus-4-6': {
        input_tokens: 5446108, output_tokens: 10698636,
        cache_read_input_tokens: 7622956710, cache_creation_input_tokens: 446014090,
        cache_5m_input_tokens: 186014090, cache_1h_input_tokens: 260000000,
        entries: 98245,
      },
      'claude-haiku-4-5-20251001': {
        input_tokens: 450000, output_tokens: 900000,
        cache_read_input_tokens: 644000000, cache_creation_input_tokens: 37400000,
        cache_5m_input_tokens: 15400000, cache_1h_input_tokens: 22000000,
        entries: 8216,
      },
    },
  };
}

function mockCostResult(): CostResult {
  return {
    input: 29.48, output: 289.97, cache_read: 4133.48,
    cache_creation_5m: 1258.75, cache_creation_1h: 2820.00,
    total: 8531.68,
    by_model: {
      'claude-opus-4-6': { input: 27.23, output: 267.47, cache_read: 3811.48, cache_creation_5m: 1162.59, cache_creation_1h: 2600.00, total: 7868.77, fallback: false },
      'claude-haiku-4-5-20251001': { input: 0.45, output: 4.50, cache_read: 64.40, cache_creation_5m: 19.25, cache_creation_1h: 44.00, total: 132.60, fallback: false },
    },
    pricing_source: 'bundled',
    pricing_version: '2026-03-22',
  };
}

describe('renderFullReport', () => {
  it('returns a non-empty string', () => {
    const output = renderFullReport(mockAggResult(), mockCostResult(), { noColor: true });
    expect(output.length).toBeGreaterThan(100);
  });

  it('contains period info', () => {
    const output = renderFullReport(mockAggResult(), mockCostResult(), { noColor: true });
    expect(output).toContain('March 2026');
  });

  it('contains formatted token numbers', () => {
    const output = renderFullReport(mockAggResult(), mockCostResult(), { noColor: true });
    expect(output).toContain('5.9M');  // input tokens
    expect(output).toContain('11.6M'); // output tokens
  });

  it('contains model breakdown', () => {
    const output = renderFullReport(mockAggResult(), mockCostResult(), { noColor: true });
    expect(output).toContain('claude-opus-4-6');
    expect(output).toContain('claude-haiku-4-5');
  });

  it('contains cost totals', () => {
    const output = renderFullReport(mockAggResult(), mockCostResult(), { noColor: true });
    expect(output).toContain('$8.5K');
  });
});

describe('renderCompactReport', () => {
  it('returns a shorter output than full report', () => {
    const full = renderFullReport(mockAggResult(), mockCostResult(), { noColor: true });
    const compact = renderCompactReport(mockAggResult(), mockCostResult(), { noColor: true });
    expect(compact.length).toBeLessThan(full.length);
  });
});

describe('renderJsonReport', () => {
  it('returns valid JSON', () => {
    const json = renderJsonReport(mockAggResult(), mockCostResult());
    const parsed = JSON.parse(json);
    expect(parsed.totals).toBeDefined();
    expect(parsed.cost_estimate_usd).toBeDefined();
  });

  it('contains raw numbers not formatted', () => {
    const json = renderJsonReport(mockAggResult(), mockCostResult());
    const parsed = JSON.parse(json);
    expect(parsed.totals.input_tokens).toBe(5896108);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx jest tests/core/renderer.test.ts`
Expected: FAIL

**Step 3: Implement renderer**

This is the largest module. Implement `renderFullReport`, `renderCompactReport`, and `renderJsonReport`. The full report uses box-drawing characters (UTF-8: `╔═╗║╚╝┌─┐│└┘`) and chalk for colors. The compact report is a flat text format. JSON report returns `JSON.stringify` of the combined aggregation + cost data.

Key implementation details:
- Use `chalk` for colors, but respect `noColor` option
- Format tokens with `formatTokens()` from formatter module
- Format costs with `formatCost()` from formatter module
- Build progress bars for model percentages: `█` for filled, `░` for empty
- Period label → human-readable title (e.g., `this-month` → `March 2026`)

The renderer code is ~200 lines — implement the three exported functions matching the test expectations. Use the CLI output examples from the design doc as the reference for exact formatting.

**Step 4: Run tests**

Run: `npx jest tests/core/renderer.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/core/renderer.ts tests/core/renderer.test.ts
git commit -m "feat: add CLI output renderer with full, compact, and JSON modes"
```

---

## Task 11: CLI Entry Point + Time Commands

**Files:**
- Modify: `src/cli.ts`
- Create: `src/commands/report.ts` (unified handler for all time commands)
- Create: `src/core/date-ranges.ts`
- Create: `tests/core/date-ranges.test.ts`

**Step 1: Write failing tests for date ranges**

```typescript
// tests/core/date-ranges.test.ts
import { getDateRange } from '../src/core/date-ranges';

// Fix "now" for deterministic tests
const NOW = new Date('2026-03-22T14:30:00Z');

describe('getDateRange', () => {
  it('today: midnight to now', () => {
    const { start, end } = getDateRange('today', NOW);
    expect(start.toISOString()).toContain('2026-03-22');
    expect(start.getHours()).toBe(0);
    expect(end.getTime()).toBe(NOW.getTime());
  });

  it('yesterday: full previous day', () => {
    const { start, end } = getDateRange('yesterday', NOW);
    expect(start.toISOString()).toContain('2026-03-21');
    expect(start.getHours()).toBe(0);
    expect(end.getHours()).toBe(23);
  });

  it('this-week: Monday to now', () => {
    const { start } = getDateRange('this-week', NOW);
    expect(start.getDay()).toBe(1); // Monday
  });

  it('this-month: 1st to now', () => {
    const { start } = getDateRange('this-month', NOW);
    expect(start.getDate()).toBe(1);
  });

  it('last-month: full previous month', () => {
    const { start, end } = getDateRange('last-month', NOW);
    expect(start.getMonth()).toBe(1); // February
    expect(start.getDate()).toBe(1);
  });

  it('this-year: Jan 1 to now', () => {
    const { start } = getDateRange('this-year', NOW);
    expect(start.getMonth()).toBe(0);
    expect(start.getDate()).toBe(1);
  });

  it('last30: 30 days ago to now', () => {
    const { start, end } = getDateRange('last30', NOW);
    const diff = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
    expect(diff).toBeCloseTo(30, 0);
  });

  it('custom range', () => {
    const { start, end } = getDateRange('range', NOW, '2026-02-01', '2026-02-28');
    expect(start.toISOString()).toContain('2026-02-01');
    expect(end.toISOString()).toContain('2026-02-28');
  });
});
```

**Step 2: Implement date-ranges module**

```typescript
// src/core/date-ranges.ts
export interface DateRange {
  start: Date;
  end: Date;
  label: string;
}

export function getDateRange(
  command: string,
  now: Date = new Date(),
  rangeStart?: string,
  rangeEnd?: string,
): DateRange {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);

  switch (command) {
    case 'today':
      return { start: today, end: now, label: 'today' };

    case 'yesterday': {
      const start = new Date(today);
      start.setDate(start.getDate() - 1);
      const end = new Date(start);
      end.setHours(23, 59, 59, 999);
      return { start, end, label: 'yesterday' };
    }

    case 'this-week': {
      const start = new Date(today);
      const day = start.getDay();
      const diff = day === 0 ? 6 : day - 1; // Monday = 0
      start.setDate(start.getDate() - diff);
      return { start, end: now, label: 'this-week' };
    }

    case 'last-week': {
      const start = new Date(today);
      const day = start.getDay();
      const diff = day === 0 ? 6 : day - 1;
      start.setDate(start.getDate() - diff - 7);
      const end = new Date(start);
      end.setDate(end.getDate() + 6);
      end.setHours(23, 59, 59, 999);
      return { start, end, label: 'last-week' };
    }

    case 'this-month': {
      const start = new Date(today);
      start.setDate(1);
      return { start, end: now, label: 'this-month' };
    }

    case 'last-month': {
      const start = new Date(today);
      start.setMonth(start.getMonth() - 1, 1);
      const end = new Date(today);
      end.setDate(0); // last day of previous month
      end.setHours(23, 59, 59, 999);
      return { start, end, label: 'last-month' };
    }

    case 'this-year': {
      const start = new Date(today);
      start.setMonth(0, 1);
      return { start, end: now, label: 'this-year' };
    }

    case 'last30': {
      const start = new Date(now);
      start.setDate(start.getDate() - 30);
      return { start, end: now, label: 'last30' };
    }

    case 'all':
      return {
        start: new Date('2020-01-01'),
        end: now,
        label: 'all',
      };

    case 'range': {
      if (!rangeStart || !rangeEnd) throw new Error('Range requires start and end dates');
      const start = new Date(rangeStart);
      start.setHours(0, 0, 0, 0);
      const end = new Date(rangeEnd);
      end.setHours(23, 59, 59, 999);
      return { start, end, label: 'range' };
    }

    default:
      throw new Error(`Unknown command: ${command}`);
  }
}
```

**Step 3: Implement the unified report command**

```typescript
// src/commands/report.ts
// Orchestrates: path resolution → file discovery → scanning → aggregation → cost → render
// Takes: command name, flags (json, fresh, compact, noColor, verbose)
// Returns: formatted string output

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '../core/config-manager.js';
import { discoverLogPaths } from '../core/path-resolver.js';
import { scanFile } from '../core/scanner.js';
import { Aggregator } from '../core/aggregator.js';
import { calculateCosts } from '../core/cost-calculator.js';
import { getDateRange } from '../core/date-ranges.js';
import { renderFullReport, renderCompactReport, renderJsonReport } from '../core/renderer.js';

export interface ReportFlags {
  json?: boolean;
  fresh?: boolean;
  compact?: boolean;
  noColor?: boolean;
  verbose?: boolean;
}

function findJsonlFiles(dirPath: string): string[] {
  const files: string[] = [];
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        files.push(...findJsonlFiles(full));
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(full);
      }
    }
  } catch { /* skip unreadable dirs */ }
  return files;
}

export async function runReport(
  command: string,
  flags: ReportFlags,
  rangeStart?: string,
  rangeEnd?: string,
): Promise<string> {
  const configManager = new ConfigManager();
  const config = configManager.load();

  // Resolve paths
  let logPaths = config.logPaths.length > 0 ? config.logPaths : discoverLogPaths();
  if (logPaths.length === 0) {
    return 'No Claude Code logs found. Run "claude-meter setup" to configure your log path.';
  }

  // Save discovered paths
  if (config.logPaths.length === 0) {
    configManager.set('logPaths', logPaths);
  }

  // Date range
  const dateRange = getDateRange(command, new Date(), rangeStart, rangeEnd);

  // Scan all files
  const aggregator = new Aggregator();
  let totalFiles = 0;
  let totalSkipped = 0;

  for (const logPath of logPaths) {
    const files = findJsonlFiles(logPath);
    totalFiles += files.length;
    for (const file of files) {
      const stats = await scanFile(file, (entry) => aggregator.add(entry), {
        start: dateRange.start,
        end: dateRange.end,
      });
      totalSkipped += stats.skippedLines;
    }
  }

  aggregator.setFilesScanned(totalFiles);

  // Aggregate + cost
  const aggResult = aggregator.getResult(dateRange.label, dateRange.start, dateRange.end);
  const costResult = calculateCosts(aggResult, config.pricing.overrides as any);

  // Render
  if (flags.json) return renderJsonReport(aggResult, costResult);
  if (flags.compact) return renderCompactReport(aggResult, costResult, { noColor: flags.noColor });
  return renderFullReport(aggResult, costResult, { noColor: flags.noColor, verbose: flags.verbose, skippedLines: totalSkipped });
}
```

**Step 4: Wire up CLI entry point**

```typescript
// src/cli.ts
#!/usr/bin/env node
import { Command } from 'commander';
import { runReport } from './commands/report.js';

const program = new Command();

program
  .name('claude-meter')
  .description('Claude Code token usage tracking and cost estimation')
  .version('0.1.0');

// Default command (no subcommand = this-month)
const timeCommands = [
  'today', 'yesterday', 'this-week', 'last-week',
  'this-month', 'last-month', 'this-year', 'last30', 'all',
];

for (const cmd of timeCommands) {
  program
    .command(cmd)
    .description(`Show usage for ${cmd}`)
    .option('--json', 'Output as JSON')
    .option('--fresh', 'Show only fresh tokens (no cache)')
    .option('--compact', 'Compact output')
    .option('--no-color', 'Disable colors')
    .option('--verbose', 'Show scan details')
    .action(async (opts) => {
      const output = await runReport(cmd, opts);
      console.log(output);
    });
}

program
  .command('range <start> <end>')
  .description('Show usage for a custom date range (YYYY-MM-DD)')
  .option('--json', 'Output as JSON')
  .option('--compact', 'Compact output')
  .option('--no-color', 'Disable colors')
  .option('--verbose', 'Show scan details')
  .action(async (start, end, opts) => {
    const output = await runReport('range', opts, start, end);
    console.log(output);
  });

// Default action (no subcommand)
program.action(async (opts) => {
  const output = await runReport('this-month', opts ?? {});
  console.log(output);
});

program.parse();
```

**Step 5: Build and test manually**

Run: `npm run build && node dist/cli.js today --json`
Expected: JSON output with today's usage data (or empty result if no logs)

**Step 6: Run all tests**

Run: `npx jest`
Expected: All PASS

**Step 7: Commit**

```bash
git add src/cli.ts src/commands/report.ts src/core/date-ranges.ts tests/core/date-ranges.test.ts
git commit -m "feat: add CLI entry point with all time commands and report pipeline"
```

---

## Task 12: Management Commands — config, paths, doctor, setup

**Files:**
- Create: `src/commands/config-cmd.ts`
- Create: `src/commands/paths-cmd.ts`
- Create: `src/commands/doctor-cmd.ts`
- Create: `src/commands/setup-cmd.ts`
- Modify: `src/cli.ts` (register new commands)

**Step 1: Implement config command**

```typescript
// src/commands/config-cmd.ts
import { ConfigManager } from '../core/config-manager.js';

export async function runConfig(action?: string, keyValue?: string): Promise<string> {
  const cm = new ConfigManager();

  if (action === 'reset') {
    cm.reset();
    return 'Config reset to defaults.';
  }

  if (action === 'set' && keyValue) {
    const eqIdx = keyValue.indexOf('=');
    if (eqIdx === -1) return 'Usage: claude-meter config --set key=value';
    const key = keyValue.substring(0, eqIdx);
    let value: unknown = keyValue.substring(eqIdx + 1);
    // Try to parse JSON values
    try { value = JSON.parse(value as string); } catch { /* keep as string */ }
    cm.set(key, value);
    return `Set ${key} = ${JSON.stringify(value)}`;
  }

  // Default: show config
  const config = cm.load();
  return JSON.stringify(config, null, 2);
}
```

**Step 2: Implement paths command**

```typescript
// src/commands/paths-cmd.ts
import { ConfigManager } from '../core/config-manager.js';
import { discoverLogPaths, validatePath } from '../core/path-resolver.js';

export async function runPaths(): Promise<string> {
  const cm = new ConfigManager();
  const config = cm.load();
  const paths = config.logPaths.length > 0 ? config.logPaths : discoverLogPaths();

  if (paths.length === 0) {
    return 'No log paths found. Run "claude-meter setup" to configure.';
  }

  const lines: string[] = ['Log Paths:', ''];
  for (let i = 0; i < paths.length; i++) {
    const v = validatePath(paths[i]);
    lines.push(`  ${i + 1}. ${paths[i]}`);
    lines.push(`     Files: ${v.fileCount} | Status: ${v.valid ? 'accessible' : v.error}`);
    lines.push(`     Source: ${config.logPaths.length > 0 ? 'saved in config' : 'auto-detected'}`);
    lines.push('');
  }

  return lines.join('\n');
}
```

**Step 3: Implement doctor command**

```typescript
// src/commands/doctor-cmd.ts
// Full diagnostic output:
// - Config file status
// - Pricing version
// - Cache status
// - Log path accessibility, file counts
// - Sample parse test
// - Model detection
// - Statusline status
```

Implement similarly to the `paths` command but more comprehensive. Check config file exists, pricing version from `getPricingVersion()`, cache age from `CacheManager`, validate each log path, attempt to parse one entry from the first file found, list models found.

**Step 4: Implement setup command**

```typescript
// src/commands/setup-cmd.ts
// Interactive flow using inquirer:
// 1. Scan default paths, display results
// 2. Ask if user wants to add more paths
// 3. Validate each added path
// 4. Save to config
```

Use `inquirer` for interactive prompts. Follow the design doc's setup flow exactly.

**Step 5: Register all commands in cli.ts**

Add `program.command('config')`, `program.command('paths')`, `program.command('doctor')`, `program.command('setup')` to `src/cli.ts`.

**Step 6: Build and test manually**

Run: `npm run build && node dist/cli.js doctor`
Expected: Diagnostic output

Run: `npm run build && node dist/cli.js paths`
Expected: Path listing

Run: `npm run build && node dist/cli.js config`
Expected: JSON config output

**Step 7: Commit**

```bash
git add src/commands/config-cmd.ts src/commands/paths-cmd.ts src/commands/doctor-cmd.ts src/commands/setup-cmd.ts src/cli.ts
git commit -m "feat: add config, paths, doctor, and setup management commands"
```

---

## Task 13: Statusline Command

**Files:**
- Create: `src/commands/statusline-cmd.ts`
- Create: `tests/commands/statusline.test.ts`
- Modify: `src/cli.ts`

**Step 1: Write failing tests**

```typescript
// tests/commands/statusline.test.ts
import { renderStatusline } from '../src/commands/statusline-cmd';

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
  it('produces output for replace mode', () => {
    const output = renderStatusline(MOCK_STDIN, 'replace', { noColor: true });
    const lines = output.split('\n').filter(Boolean);
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain('Opus');
    expect(lines[0]).toContain('%');
  });

  it('produces single line for inline mode', () => {
    const output = renderStatusline(MOCK_STDIN, 'inline', { noColor: true });
    const lines = output.split('\n').filter(Boolean);
    expect(lines.length).toBe(1);
  });

  it('includes cost in output', () => {
    const output = renderStatusline(MOCK_STDIN, 'inline', { noColor: true });
    expect(output).toContain('$');
  });
});
```

**Step 2: Implement statusline command**

The statusline command:
1. Reads JSON from stdin (piped by Claude Code)
2. For **replace mode**: renders 2 lines (session context + meter data)
3. For **add mode**: renders 1 line (meter data only, user's script handles line 1)
4. For **inline mode**: renders 1 compact line
5. Reads historical data from cache (via CacheManager)
6. If cache is stale, triggers background rescan

Line 1 (replace mode): Model, progress bar, percentage, tokens, git branch, project name — replicate the Python statusline logic in Node.js.

Line 2 / inline: Historical aggregate — today's tokens + cost, this month's tokens + cost, model split percentages.

**Step 3: Register in cli.ts**

```typescript
program
  .command('statusline')
  .option('--inline', 'Single compact line for embedding')
  .option('--mode <mode>', 'Output mode: replace, add, inline', 'replace')
  .action(async (opts) => {
    // Read stdin JSON
    const input = await readStdin();
    const data = JSON.parse(input);
    const output = renderStatusline(data, opts.mode ?? opts.inline ? 'inline' : 'replace');
    process.stdout.write(output);
  });
```

**Step 4: Run tests**

Run: `npx jest tests/commands/statusline.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/commands/statusline-cmd.ts tests/commands/statusline.test.ts src/cli.ts
git commit -m "feat: add statusline command with replace, add, and inline modes"
```

---

## Task 14: Install/Uninstall Statusline Commands

**Files:**
- Create: `src/commands/install-statusline-cmd.ts`
- Create: `src/commands/uninstall-statusline-cmd.ts`
- Modify: `src/cli.ts`

**Step 1: Implement install-statusline**

```typescript
// src/commands/install-statusline-cmd.ts
// 1. Find Claude Code settings.json (platform-specific path)
// 2. Read existing settings
// 3. Check if statusLine already configured
// 4. If no existing: set to "claude-meter statusline"
// 5. If existing: prompt with inquirer (Replace / Add / Skip)
//    - Replace: set command to "claude-meter statusline"
//    - Add: create wrapper script, set command to wrapper
//    - Skip: show manual instructions
// 6. Backup original settings to ~/.claude-meter/settings-backup.json
// 7. Write updated settings
```

Key implementation details:
- Claude Code settings paths:
  - Windows: `%APPDATA%\Claude\settings.json` or `~/.claude/settings.json`
  - macOS: `~/Library/Application Support/Claude/settings.json` or `~/.claude/settings.json`
  - Linux: `~/.config/claude/settings.json` or `~/.claude/settings.json`
- For **Add mode**, generate a wrapper shell script at `~/.claude-meter/statusline-wrapper.sh` (Unix) or `~/.claude-meter/statusline-wrapper.cmd` (Windows) that pipes stdin to both the original command and `claude-meter statusline --inline`
- Always backup before modifying

**Step 2: Implement uninstall-statusline**

```typescript
// src/commands/uninstall-statusline-cmd.ts
// 1. Check if backup exists at ~/.claude-meter/settings-backup.json
// 2. If yes: restore from backup
// 3. If no: remove statusLine key from settings
// 4. Clean up wrapper script if it exists
```

**Step 3: Register in cli.ts**

Add `install-statusline` and `uninstall-statusline` commands.

**Step 4: Build and test manually**

Run: `npm run build && node dist/cli.js install-statusline`
Expected: Interactive prompt or success message

**Step 5: Commit**

```bash
git add src/commands/install-statusline-cmd.ts src/commands/uninstall-statusline-cmd.ts src/cli.ts
git commit -m "feat: add install/uninstall statusline with replace, add, skip options"
```

---

## Task 15: Watch Mode

**Files:**
- Create: `src/commands/watch-cmd.ts`
- Modify: `src/cli.ts`

**Step 1: Implement watch command**

```typescript
// src/commands/watch-cmd.ts
// 1. Clear terminal
// 2. Run report for today, this-week, this-month
// 3. Display dashboard with box-drawing
// 4. Set interval (default 30s) to re-run and redraw
// 5. Handle Ctrl+C gracefully
// 6. Support --compact and --interval flags
// 7. Support --json for streaming JSON objects
```

Key implementation details:
- Use `process.stdout.write('\x1Bc')` to clear terminal
- Use `setInterval` for refresh
- Each refresh runs 3 aggregations (today, this-week, this-month) — or use cache for the longer periods
- Show "Last entry: X ago" by checking the most recent timestamp in today's scan
- Show countdown to next refresh
- Handle `SIGINT` to clean exit

**Step 2: Register in cli.ts**

```typescript
program
  .command('watch')
  .description('Live updating usage dashboard')
  .option('--interval <seconds>', 'Refresh interval in seconds', '30')
  .option('--compact', 'Minimal output')
  .option('--json', 'Stream JSON objects')
  .action(async (opts) => {
    await runWatch(opts);
  });
```

**Step 3: Build and test manually**

Run: `npm run build && node dist/cli.js watch --compact --interval 5`
Expected: Live updating compact view, refreshing every 5 seconds

**Step 4: Commit**

```bash
git add src/commands/watch-cmd.ts src/cli.ts
git commit -m "feat: add live watch mode with configurable refresh interval"
```

---

## Task 16: Integration Testing

**Files:**
- Create: `tests/integration/cli.test.ts`
- Create: `tests/integration/full-pipeline.test.ts`

**Step 1: Write integration tests**

```typescript
// tests/integration/full-pipeline.test.ts
import { Aggregator } from '../../src/core/aggregator';
import { scanFile } from '../../src/core/scanner';
import { calculateCosts } from '../../src/core/cost-calculator';
import { renderJsonReport } from '../../src/core/renderer';
import { join } from 'node:path';

describe('Full pipeline integration', () => {
  it('scans fixture → aggregates → calculates costs → renders JSON', async () => {
    const fixturePath = join(__dirname, '..', 'fixtures', 'sample.jsonl');
    const aggregator = new Aggregator();

    await scanFile(fixturePath, (entry) => aggregator.add(entry));
    aggregator.setFilesScanned(1);

    const aggResult = aggregator.getResult('today', new Date('2026-03-01'), new Date('2026-03-31'));
    const costResult = calculateCosts(aggResult);
    const json = renderJsonReport(aggResult, costResult);
    const parsed = JSON.parse(json);

    expect(parsed.totals.entries_matched).toBe(3);
    expect(parsed.totals.input_tokens).toBe(300); // 100 + 50 + 150
    expect(parsed.cost_estimate_usd.total).toBeGreaterThan(0);
    expect(Object.keys(parsed.by_model)).toContain('claude-opus-4-6');
    expect(Object.keys(parsed.by_model)).toContain('claude-haiku-4-5-20251001');
  });
});
```

**Step 2: Run all tests**

Run: `npx jest`
Expected: All PASS

**Step 3: Commit**

```bash
git add tests/integration/
git commit -m "test: add integration tests for full scan-to-output pipeline"
```

---

## Task 17: README + Showcase Page

**Files:**
- Create: `README.md`
- Create: `docs/showcase/index.html`

**Step 1: Write comprehensive README**

Structure (star-optimized format):
1. Hero section with project name + one-liner + badges (npm version, license, platform, node version)
2. Animated terminal GIF placeholder (to be recorded after build)
3. "Why Claude Meter?" — 3-4 bullet pain points it solves
4. Quick Start — 3 lines: install, first command, enable statusline
5. Features grid — icons + short descriptions
6. Commands Reference — full table of all commands with examples
7. Configuration — all config keys with defaults
8. Statusline — install/add/replace with screenshots
9. Output Examples — full, compact, JSON, watch
10. Setup & Path Discovery — auto-scan, manual setup, Docker, WSL
11. Pricing — bundled rates, overrides, how to update
12. FAQ / Troubleshooting — common issues + `claude-meter doctor`
13. Contributing — dev setup, build, test, PR process
14. License — MIT

**Step 2: Write showcase HTML page**

Create `docs/showcase/index.html` — a single-page landing site with:
- Hero banner with gradient background
- Terminal mockup showing CLI output (CSS-styled, not image)
- Feature cards with icons
- Installation section
- Footer with GitHub link + npm link

Use modern CSS (no framework needed), dark theme matching terminal aesthetic.

**Step 3: Commit**

```bash
git add README.md docs/showcase/index.html
git commit -m "docs: add comprehensive README and showcase landing page"
```

---

## Task 18: Final Polish + Publish Prep

**Files:**
- Modify: `package.json` (verify all fields)
- Create: `LICENSE`
- Verify: `.gitignore` includes all necessary exclusions
- Verify: `npm pack` produces clean package

**Step 1: Add LICENSE file (MIT)**

**Step 2: Verify package.json fields**

Check: name, version, description, bin, main, files, engines, keywords, author, license, repository, homepage, bugs

**Step 3: Build and dry-run publish**

Run: `npm run build && npm pack --dry-run`
Expected: List of files that would be included — verify no test files, no source maps in production, pricing.json included

**Step 4: Run full test suite**

Run: `npm test`
Expected: All PASS

**Step 5: Test global install locally**

Run: `npm pack && npm install -g callobuzz-claude-meter-0.1.0.tgz`
Run: `claude-meter today`
Expected: Working CLI output

**Step 6: Commit**

```bash
git add LICENSE package.json .gitignore
git commit -m "chore: finalize package for npm publish"
```

---

## Execution Summary

| Task | Module | Est. Complexity |
|---|---|---|
| 1 | Project scaffolding | Low |
| 2 | Formatter (K/M/B) | Low |
| 3 | Pricing (bundled + matching) | Medium |
| 4 | Config manager | Medium |
| 5 | Path resolver | Medium |
| 6 | Scanner (streaming JSONL) | Medium |
| 7 | Aggregator | Medium |
| 8 | Cache manager | Low |
| 9 | Cost calculator | Medium |
| 10 | Output renderer | High |
| 11 | CLI + time commands | High |
| 12 | Management commands | Medium |
| 13 | Statusline command | High |
| 14 | Install/uninstall statusline | Medium |
| 15 | Watch mode | Medium |
| 16 | Integration tests | Medium |
| 17 | README + showcase | High |
| 18 | Final polish | Low |

**Dependencies:** Tasks 2-8 are independent core modules (can be parallelized). Task 9 depends on 3+7. Task 10 depends on 2+9. Task 11 depends on all core. Tasks 12-15 depend on 11. Task 16 depends on all. Task 17-18 are final.
