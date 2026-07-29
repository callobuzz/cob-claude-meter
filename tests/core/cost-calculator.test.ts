import { calculateCosts } from '../../src/core/cost-calculator.js';
import { AggregationResult } from '../../src/core/aggregator.js';

function makeAggResult(): AggregationResult {
  return {
    period: { label: 'today', start: '2026-03-22T00:00:00Z', end: '2026-03-22T23:59:59Z' },
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
        input_tokens: 4_000_000,
        output_tokens: 8_000_000,
        cache_read_input_tokens: 80_000_000,
        cache_creation_input_tokens: 40_000_000,
        cache_5m_input_tokens: 16_000_000,
        cache_1h_input_tokens: 24_000_000,
        entries: 1,
      },
      'claude-haiku-4-5-20251001': {
        input_tokens: 1_000_000,
        output_tokens: 2_000_000,
        cache_read_input_tokens: 20_000_000,
        cache_creation_input_tokens: 10_000_000,
        cache_5m_input_tokens: 4_000_000,
        cache_1h_input_tokens: 6_000_000,
        entries: 1,
      },
    },
  } as unknown as AggregationResult;
}

describe('calculateCosts', () => {
  it('computes per-model costs using correct rates', () => {
    const result = calculateCosts(makeAggResult());
    // Opus: input 4M * $5/M = $20
    expect(result.by_model['claude-opus-4-6'].input).toBeCloseTo(20.00, 1);
    // Opus: output 8M * $25/M = $200
    expect(result.by_model['claude-opus-4-6'].output).toBeCloseTo(200.00, 1);
    // Haiku: input 1M * $1/M = $1
    expect(result.by_model['claude-haiku-4-5-20251001'].input).toBeCloseTo(1.00, 1);
    // Haiku: output 2M * $5/M = $10
    expect(result.by_model['claude-haiku-4-5-20251001'].output).toBeCloseTo(10.00, 1);
  });

  it('computes total cost across all models', () => {
    const result = calculateCosts(makeAggResult());
    expect(result.total).toBeGreaterThan(0);
    // Total should be sum of all model costs
    let expectedTotal = 0;
    for (const mc of Object.values(result.by_model)) {
      expectedTotal += mc.total;
    }
    expect(result.total).toBeCloseTo(expectedTotal, 2);
  });

  it('computes cache costs correctly', () => {
    const result = calculateCosts(makeAggResult());
    // Opus cache_read: 80M * $0.50/M = $40
    expect(result.by_model['claude-opus-4-6'].cache_read).toBeCloseTo(40.00, 1);
    // Opus cache_5m: 16M * $6.25/M = $100
    expect(result.by_model['claude-opus-4-6'].cache_creation_5m).toBeCloseTo(100.00, 1);
    // Opus cache_1h: 24M * $10/M = $240
    expect(result.by_model['claude-opus-4-6'].cache_creation_1h).toBeCloseTo(240.00, 1);
  });

  it('marks fallback models', () => {
    const aggResult = makeAggResult();
    aggResult.by_model['claude-unknown-99'] = {
      input_tokens: 1000, output_tokens: 2000,
      cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      cache_5m_input_tokens: 0, cache_1h_input_tokens: 0, entries: 1,
    } as any;
    const result = calculateCosts(aggResult);
    expect(result.by_model['claude-unknown-99'].fallback).toBe(true);
  });

  it('includes pricing metadata', () => {
    const result = calculateCosts(makeAggResult());
    expect(result.pricing_source).toBe('bundled');
    expect(result.pricing_version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
