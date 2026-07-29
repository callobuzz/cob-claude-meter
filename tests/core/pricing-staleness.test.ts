import {
  assessPricingStaleness,
  findUnknownModels,
  isKnownModel,
  isPlaceholderModel,
  resolveModelPricing,
  getPricingVersion,
  PRICING_STALE_AFTER_DAYS,
} from '../../src/core/pricing.js';
import { runPricingCommand } from '../../src/commands/pricing-cmd.js';

const bundledVersion = getPricingVersion();
const dayAfter = (isoDate: string, days: number) =>
  new Date(Date.parse(isoDate + 'T00:00:00Z') + days * 86_400_000);

describe('isPlaceholderModel', () => {
  it('recognises the ids Claude Code invents for its own turns', () => {
    // These appear in real logs with zero tokens. Treating them as "unpriced
    // models" would put a permanent bogus warning on every single report.
    expect(isPlaceholderModel('<synthetic>')).toBe(true);
    expect(isPlaceholderModel('claude-opus-5')).toBe(false);
  });

  it('prices them at zero rather than guessing flagship rates', () => {
    const rates = resolveModelPricing('<synthetic>');
    expect(rates.input).toBe(0);
    expect(rates.output).toBe(0);
    expect(rates._fallback).toBeUndefined();
  });

  it('does not report them as unknown', () => {
    expect(findUnknownModels(['<synthetic>'])).toEqual([]);
    expect(isKnownModel('<synthetic>')).toBe(true);
  });
});

describe('findUnknownModels', () => {
  it('flags a model the bundled table has never heard of', () => {
    expect(findUnknownModels(['claude-opus-9'])).toEqual(['claude-opus-9']);
  });

  it('accepts known models, dated snapshots included', () => {
    expect(findUnknownModels(['claude-opus-5', 'claude-sonnet-5-20260101'])).toEqual([]);
  });

  it('deduplicates and sorts', () => {
    const found = findUnknownModels(['claude-zeta-1', 'claude-alpha-1', 'claude-zeta-1']);
    expect(found).toEqual(['claude-alpha-1', 'claude-zeta-1']);
  });

  it('collapses dated variants of the same unknown model', () => {
    expect(findUnknownModels(['claude-opus-9-20260714', 'claude-opus-9-20260801']))
      .toEqual(['claude-opus-9']);
  });
});

describe('assessPricingStaleness', () => {
  it('is fresh on the day it was published', () => {
    const state = assessPricingStaleness(dayAfter(bundledVersion, 0));
    expect(state.ageDays).toBe(0);
    expect(state.stale).toBe(false);
  });

  it('goes stale past the threshold', () => {
    const state = assessPricingStaleness(dayAfter(bundledVersion, PRICING_STALE_AFTER_DAYS + 1));
    expect(state.stale).toBe(true);
  });

  it('does not go stale one day early', () => {
    const state = assessPricingStaleness(dayAfter(bundledVersion, PRICING_STALE_AFTER_DAYS));
    expect(state.stale).toBe(false);
  });

  it('never reports a negative age when the clock is behind', () => {
    const state = assessPricingStaleness(dayAfter(bundledVersion, -30));
    expect(state.ageDays).toBe(0);
  });

  it('splits scheduled changes into overdue and upcoming', () => {
    const far = assessPricingStaleness(new Date('2099-01-01T00:00:00Z'));
    const early = assessPricingStaleness(new Date('2000-01-01T00:00:00Z'));
    // Every known change is in the past by 2099 and in the future in 2000.
    expect(far.upcoming).toEqual([]);
    expect(early.overdue).toEqual([]);
    expect(far.overdue.length).toBe(early.upcoming.length);
  });
});

describe('runPricingCommand', () => {
  it('lists the bundled rates and reports as current when fresh', async () => {
    const out = await runPricingCommand({ now: dayAfter(bundledVersion, 1) });
    expect(out).toContain('Bundled pricing');
    expect(out).toContain('opus-5');
    expect(out).toContain('Pricing looks current');
  });

  it('calls out models from the logs it cannot price', async () => {
    const out = await runPricingCommand({
      seen: ['claude-opus-5', 'claude-opus-9'],
      now: dayAfter(bundledVersion, 1),
    });
    expect(out).toContain('claude-opus-9');
    expect(out).toContain('not in this table');
    expect(out).toContain('npm i -g cob-claude-meter');
  });

  it('does not nag when every model in the logs is priced', async () => {
    const out = await runPricingCommand({
      seen: ['claude-opus-5', '<synthetic>'],
      now: dayAfter(bundledVersion, 1),
    });
    expect(out).not.toContain('not in this table');
  });

  it('tells the user to update once the table is old', async () => {
    const out = await runPricingCommand({
      now: dayAfter(bundledVersion, PRICING_STALE_AFTER_DAYS + 10),
    });
    expect(out).toContain(`over ${PRICING_STALE_AFTER_DAYS} days old`);
  });

  it('emits machine-readable output with --json', async () => {
    const out = await runPricingCommand({
      json: true,
      seen: ['claude-opus-9'],
      now: dayAfter(bundledVersion, 1),
    });
    const parsed = JSON.parse(out);
    expect(parsed.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(parsed.unknown_models_in_logs).toEqual(['claude-opus-9']);
    expect(parsed.models['claude-opus-5'].input).toBeGreaterThan(0);
  });
});
