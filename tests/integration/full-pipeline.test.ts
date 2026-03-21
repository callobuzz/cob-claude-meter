import { Aggregator } from '../../src/core/aggregator.js';
import { scanFile } from '../../src/core/scanner.js';
import { calculateCosts } from '../../src/core/cost-calculator.js';
import { renderJsonReport, renderFullReport, renderCompactReport } from '../../src/core/renderer.js';
import { getDateRange } from '../../src/core/date-ranges.js';
import { formatTokens, formatCost } from '../../src/core/formatter.js';
import { join } from 'node:path';

const FIXTURE_PATH = join(__dirname, '..', 'fixtures', 'sample.jsonl');

describe('Full pipeline integration', () => {
  it('scans fixture → aggregates → calculates costs → renders JSON', async () => {
    const aggregator = new Aggregator();
    await scanFile(FIXTURE_PATH, (entry) => aggregator.add(entry));
    aggregator.setFilesScanned(1);

    const aggResult = aggregator.getResult('today', new Date('2026-03-01'), new Date('2026-03-31'));
    const costResult = calculateCosts(aggResult);
    const json = renderJsonReport(aggResult, costResult);
    const parsed = JSON.parse(json);

    expect(parsed.totals.entries_matched).toBe(3);
    expect(parsed.totals.input_tokens).toBe(300); // 100 + 50 + 150
    expect(parsed.totals.output_tokens).toBe(580); // 200 + 80 + 300
    expect(parsed.cost_estimate_usd.total).toBeGreaterThan(0);
    expect(Object.keys(parsed.by_model)).toContain('claude-opus-4-6');
    expect(Object.keys(parsed.by_model)).toContain('claude-haiku-4-5-20251001');
  });

  it('correctly applies date filtering', async () => {
    const aggregator = new Aggregator();
    const dateFilter = {
      start: new Date('2026-03-22T00:00:00Z'),
      end: new Date('2026-03-22T23:59:59Z'),
    };
    await scanFile(FIXTURE_PATH, (entry) => aggregator.add(entry), dateFilter);
    aggregator.setFilesScanned(1);

    const aggResult = aggregator.getResult('today', dateFilter.start, dateFilter.end);
    expect(aggResult.totals.entries_matched).toBe(2); // Only Mar 22 entries
  });

  it('renders full report without errors', async () => {
    const aggregator = new Aggregator();
    await scanFile(FIXTURE_PATH, (entry) => aggregator.add(entry));
    aggregator.setFilesScanned(1);

    const aggResult = aggregator.getResult('today', new Date('2026-03-01'), new Date('2026-03-31'));
    const costResult = calculateCosts(aggResult);
    const fullReport = renderFullReport(aggResult, costResult, { noColor: true });

    expect(fullReport).toContain('Claude Meter');
    expect(fullReport.length).toBeGreaterThan(200);
  });

  it('renders compact report without errors', async () => {
    const aggregator = new Aggregator();
    await scanFile(FIXTURE_PATH, (entry) => aggregator.add(entry));
    aggregator.setFilesScanned(1);

    const aggResult = aggregator.getResult('today', new Date('2026-03-01'), new Date('2026-03-31'));
    const costResult = calculateCosts(aggResult);
    const compact = renderCompactReport(aggResult, costResult, { noColor: true });

    expect(compact).toContain('$');
    expect(compact.length).toBeGreaterThan(50);
  });

  it('per-model costs use correct pricing', async () => {
    const aggregator = new Aggregator();
    await scanFile(FIXTURE_PATH, (entry) => aggregator.add(entry));
    aggregator.setFilesScanned(1);

    const aggResult = aggregator.getResult('today', new Date('2026-03-01'), new Date('2026-03-31'));
    const costResult = calculateCosts(aggResult);

    // Opus uses $5/M input, Haiku uses $1/M input
    // Opus total input: 250 tokens, Haiku: 50 tokens
    expect(costResult.by_model['claude-opus-4-6'].input).toBeGreaterThan(
      costResult.by_model['claude-haiku-4-5-20251001'].input
    );
  });

  it('date ranges produce valid ranges', () => {
    const now = new Date('2026-03-22T12:00:00Z');
    const ranges = ['today', 'yesterday', 'this-week', 'last-week', 'this-month', 'last-month', 'this-year', 'last30', 'all'] as const;
    for (const label of ranges) {
      const range = getDateRange(label, now);
      expect(range.start).toBeInstanceOf(Date);
      expect(range.end).toBeInstanceOf(Date);
      expect(range.start.getTime()).toBeLessThanOrEqual(range.end.getTime());
      expect(range.label).toBe(label);
    }
  });

  it('formatter handles edge cases', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1000)).toBe('1.0K');
    expect(formatCost(0)).toBe('$0.00');
    expect(formatCost(999.99)).toBe('$999.99');
    expect(formatCost(1000)).toBe('$1.0K');
  });
});
