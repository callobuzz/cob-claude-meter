import { AggregationResult } from './aggregator.js';
import { resolveModelPricing, computeCost, getPricingVersion, ModelRates } from './pricing.js';

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

export function calculateCosts(
  aggResult: AggregationResult,
  userOverrides?: Record<string, Partial<ModelRates>>
): CostResult {
  const byModel: Record<string, ModelCost> = {};

  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCache5m = 0;
  let totalCache1h = 0;

  for (const [modelId, tokens] of Object.entries(aggResult.by_model)) {
    const rates = resolveModelPricing(modelId, userOverrides);

    const input = computeCost(tokens.input_tokens, rates.input);
    const output = computeCost(tokens.output_tokens, rates.output);
    const cacheRead = computeCost(tokens.cache_read_input_tokens, rates.cache_read);
    const cache5m = computeCost(tokens.cache_5m_input_tokens, rates.cache_write_5m);
    const cache1h = computeCost(tokens.cache_1h_input_tokens, rates.cache_write_1h);
    const total = input + output + cacheRead + cache5m + cache1h;

    byModel[modelId] = {
      input,
      output,
      cache_read: cacheRead,
      cache_creation_5m: cache5m,
      cache_creation_1h: cache1h,
      total,
      fallback: rates._fallback === true,
    };

    totalInput += input;
    totalOutput += output;
    totalCacheRead += cacheRead;
    totalCache5m += cache5m;
    totalCache1h += cache1h;
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
