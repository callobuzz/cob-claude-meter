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

interface PricingData {
  version: string;
  source: string;
  rates_per_million_tokens: Record<string, ModelRates>;
}

let cachedPricing: PricingData | null = null;

function findPricingFile(): string {
  const candidates: string[] = [];

  // When running via ts-jest or from dist/, __dirname points to src/core or dist/core
  if (typeof __dirname !== 'undefined') {
    candidates.push(join(__dirname, '..', '..', 'data', 'pricing.json'));
  }

  // Fallback: resolve from cwd (works when run as CLI from package root)
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

const FALLBACK_MODEL = 'claude-opus-4-6';

export function resolveModelPricing(
  modelId: string,
  userOverrides?: Record<string, Partial<ModelRates>>
): ModelRates {
  const pricing = loadBundledPricing();
  const rates = pricing.rates_per_million_tokens;

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
