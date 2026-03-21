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
  it('returns version string', () => {
    expect(getPricingVersion()).toBe('2026-03-22');
  });
});

describe('getAllModelIds', () => {
  it('returns all model IDs', () => {
    const ids = getAllModelIds();
    expect(ids).toContain('claude-opus-4-6');
    expect(ids).toContain('claude-haiku-3');
    expect(ids.length).toBe(10);
  });
});
