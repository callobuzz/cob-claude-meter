import { resolveModelPricing, computeCost, getPricingVersion, getAllModelIds } from '../../src/core/pricing.js';

describe('resolveModelPricing', () => {
  it('resolves exact model ID', () => {
    const rates = resolveModelPricing('claude-opus-4-6');
    expect(rates.input).toBe(5.00);
    expect(rates.output).toBe(25.00);
    expect(rates.cache_write_5m).toBe(6.25);
    expect(rates.cache_write_1h).toBe(10.00);
    expect(rates.cache_read).toBe(0.50);
  });

  it('resolves model ID with date suffix', () => {
    const rates = resolveModelPricing('claude-opus-4-5-20251101');
    expect(rates.input).toBe(5.00);
  });

  it('resolves haiku with date suffix', () => {
    const rates = resolveModelPricing('claude-haiku-4-5-20251001');
    expect(rates.input).toBe(1.00);
  });

  it('resolves sonnet models', () => {
    const rates = resolveModelPricing('claude-sonnet-4-6');
    expect(rates.input).toBe(3.00);
    expect(rates.output).toBe(15.00);
  });

  it('returns fallback for unknown model', () => {
    const rates = resolveModelPricing('claude-unknown-99');
    expect(rates.input).toBe(5.00);
    expect(rates._fallback).toBe(true);
  });

  it('applies user overrides', () => {
    const overrides = { 'claude-opus-4-6': { input: 99.00 } };
    const rates = resolveModelPricing('claude-opus-4-6', overrides);
    expect(rates.input).toBe(99.00);
    expect(rates.output).toBe(25.00); // unchanged
  });
});

describe('computeCost', () => {
  it('computes cost from tokens and rate', () => {
    expect(computeCost(5_000_000, 5.00)).toBeCloseTo(25.00, 2);
  });
  it('handles zero tokens', () => {
    expect(computeCost(0, 5.00)).toBe(0);
  });
});

describe('getPricingVersion', () => {
  // Asserting the shape, not the date: the bundled table is refreshed whenever
  // Anthropic changes rates, and a test pinned to one release would fail every
  // time for a reason that is not a defect.
  it('returns an ISO date string', () => {
    expect(getPricingVersion()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('getAllModelIds', () => {
  it('returns the model IDs, current flagship included', () => {
    const ids = getAllModelIds();
    expect(ids).toContain('claude-opus-5');
    expect(ids).toContain('claude-sonnet-5');
    expect(ids).toContain('claude-haiku-3'); // retired models stay, for old logs
    expect(ids.length).toBeGreaterThanOrEqual(10);
  });
});
