import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface ModelRates {
  input: number;
  output: number;
  cache_write_5m: number;
  cache_write_1h: number;
  cache_read: number;
  _fallback?: boolean;
}

export interface ScheduledChange {
  model: string;
  /** ISO date (YYYY-MM-DD) on which these rates replace the bundled ones. */
  effective: string;
  reason: string;
  rates: ModelRates;
}

interface PricingData {
  version: string;
  source: string;
  rates_per_million_tokens: Record<string, ModelRates>;
  scheduled_changes?: ScheduledChange[];
}

/**
 * Anthropic ships models faster than this package ships releases, so bundled
 * rates go stale between publishes. Past this age we say so out loud rather
 * than quietly reporting confident numbers derived from last quarter's prices.
 */
export const PRICING_STALE_AFTER_DAYS = 90;

let cachedPricing: PricingData | null = null;

// Injected at build time by cli.ts — set before any pricing calls
let _packageRoot: string = '';

export function setPricingRoot(root: string): void {
  _packageRoot = root;
}

function findPricingFile(): string {
  const candidates: string[] = [];

  // Set by cli.ts at startup (works in ESM global install)
  if (_packageRoot) {
    candidates.push(join(_packageRoot, 'data', 'pricing.json'));
  }

  // CJS compat (__dirname available in ts-jest)
  if (typeof __dirname !== 'undefined') {
    candidates.push(join(__dirname, '..', '..', 'data', 'pricing.json'));
  }

  // Fallback: cwd
  candidates.push(join(process.cwd(), 'data', 'pricing.json'));

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error('Could not locate data/pricing.json');
}

function loadBundledPricing(): PricingData {
  if (cachedPricing) return cachedPricing;
  const pricingPath = findPricingFile();
  cachedPricing = JSON.parse(readFileSync(pricingPath, 'utf-8'));
  return cachedPricing!;
}

function stripDateSuffix(modelId: string): string {
  return modelId.replace(/-\d{8}$/, '');
}

/** Unknown models are priced as the current flagship — the closest safe guess. */
const FALLBACK_MODEL = 'claude-opus-5';

/**
 * Claude Code writes placeholder ids like `<synthetic>` for turns it generated
 * itself (API errors, injected notices). They are not models, always carry zero
 * tokens, and must not be reported as unpriced — otherwise every report warns
 * about a "missing" model that costs nothing and will never appear in a rate card.
 */
const PLACEHOLDER_MODEL_ID = /^<.*>$/;

const ZERO_RATES: ModelRates = {
  input: 0,
  output: 0,
  cache_write_5m: 0,
  cache_write_1h: 0,
  cache_read: 0,
};

export function isPlaceholderModel(modelId: string): boolean {
  return PLACEHOLDER_MODEL_ID.test(modelId);
}

export function resolveModelPricing(
  modelId: string,
  userOverrides?: Record<string, Partial<ModelRates>>
): ModelRates {
  const pricing = loadBundledPricing();
  const rates = pricing.rates_per_million_tokens;

  if (isPlaceholderModel(modelId)) return { ...ZERO_RATES };

  // Get base rates (exact match -> stripped -> fallback)
  let baseRates: ModelRates;
  let isFallback = false;

  if (rates[modelId]) {
    baseRates = { ...rates[modelId] };
  } else {
    const stripped = stripDateSuffix(modelId);
    if (rates[stripped]) {
      baseRates = { ...rates[stripped] };
    } else {
      baseRates = { ...rates[FALLBACK_MODEL], _fallback: true };
      isFallback = true;
    }
  }

  // Apply user overrides
  if (userOverrides?.[modelId]) {
    Object.assign(baseRates, userOverrides[modelId]);
  }

  if (isFallback) baseRates._fallback = true;
  return baseRates;
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

export function getPricingSource(): string {
  return loadBundledPricing().source;
}

export function getScheduledChanges(): ScheduledChange[] {
  return loadBundledPricing().scheduled_changes ?? [];
}

/**
 * True when this model would fall through to FALLBACK_MODEL, i.e. the bundled
 * table has never heard of it. Costs are still reported, but they are a guess.
 */
export function isKnownModel(modelId: string): boolean {
  if (isPlaceholderModel(modelId)) return true; // not a model; nothing to price
  const rates = loadBundledPricing().rates_per_million_tokens;
  return Boolean(rates[modelId] ?? rates[stripDateSuffix(modelId)]);
}

/** Model IDs seen in the logs that the bundled table cannot price. */
export function findUnknownModels(modelIds: Iterable<string>): string[] {
  const unknown = new Set<string>();
  for (const id of modelIds) {
    if (!isKnownModel(id)) unknown.add(stripDateSuffix(id));
  }
  return [...unknown].sort();
}

export interface PricingStaleness {
  version: string;
  source: string;
  ageDays: number;
  stale: boolean;
  /** Rate changes whose effective date has passed — the bundle is now wrong. */
  overdue: ScheduledChange[];
  /** Rate changes still in the future — worth knowing, not yet a problem. */
  upcoming: ScheduledChange[];
}

export function assessPricingStaleness(now: Date = new Date()): PricingStaleness {
  const data = loadBundledPricing();
  const published = Date.parse(data.version + 'T00:00:00Z');
  const ageDays = Number.isNaN(published)
    ? Number.POSITIVE_INFINITY
    : Math.max(0, Math.floor((now.getTime() - published) / 86_400_000));

  const overdue: ScheduledChange[] = [];
  const upcoming: ScheduledChange[] = [];
  for (const change of data.scheduled_changes ?? []) {
    const at = Date.parse(change.effective + 'T00:00:00Z');
    if (!Number.isNaN(at) && at <= now.getTime()) overdue.push(change);
    else upcoming.push(change);
  }

  return {
    version: data.version,
    source: data.source,
    ageDays,
    stale: ageDays > PRICING_STALE_AFTER_DAYS,
    overdue,
    upcoming,
  };
}
