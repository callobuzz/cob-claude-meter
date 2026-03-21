import { renderFullReport, renderCompactReport, renderJsonReport } from '../../src/core/renderer.js';
import { AggregationResult } from '../../src/core/aggregator.js';
import { CostResult } from '../../src/core/cost-calculator.js';

function mockAggResult(): AggregationResult {
  return {
    period: { label: 'this-month', start: '2026-03-01T00:00:00.000Z', end: '2026-03-22T23:59:59.000Z' },
    totals: {
      entries_matched: 106461, files_scanned: 2568, sessions: 847,
      input_tokens: 5896108, output_tokens: 11598636,
      cache_read_input_tokens: 8266956710, cache_creation_input_tokens: 483414090,
      cache_5m_input_tokens: 201414090, cache_1h_input_tokens: 282000000,
      fresh_total: 17494744, full_total: 8767865544,
      web_searches: 42, web_fetches: 18,
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
  } as unknown as AggregationResult;
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
    expect(output).toContain('Mar');
    expect(output).toContain('2026');
  });

  it('contains formatted token numbers', () => {
    const output = renderFullReport(mockAggResult(), mockCostResult(), { noColor: true });
    expect(output).toContain('5.9M');
    expect(output).toContain('11.6M');
  });

  it('contains model breakdown', () => {
    const output = renderFullReport(mockAggResult(), mockCostResult(), { noColor: true });
    expect(output).toContain('claude-opus-4-6');
    expect(output).toContain('claude-haiku-4-5');
  });

  it('contains cost total', () => {
    const output = renderFullReport(mockAggResult(), mockCostResult(), { noColor: true });
    expect(output).toContain('$8.5K');
  });

  it('contains box-drawing characters', () => {
    const output = renderFullReport(mockAggResult(), mockCostResult(), { noColor: true });
    expect(output).toMatch(/[╔═╗║╚╝┌─┐│└┘]/);
  });
});

describe('renderCompactReport', () => {
  it('returns a shorter output than full report', () => {
    const full = renderFullReport(mockAggResult(), mockCostResult(), { noColor: true });
    const compact = renderCompactReport(mockAggResult(), mockCostResult(), { noColor: true });
    expect(compact.length).toBeLessThan(full.length);
  });

  it('contains key metrics', () => {
    const compact = renderCompactReport(mockAggResult(), mockCostResult(), { noColor: true });
    expect(compact).toContain('106,461');
    expect(compact).toContain('$8.5K');
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

  it('contains by_model data', () => {
    const json = renderJsonReport(mockAggResult(), mockCostResult());
    const parsed = JSON.parse(json);
    expect(parsed.by_model['claude-opus-4-6']).toBeDefined();
  });
});
