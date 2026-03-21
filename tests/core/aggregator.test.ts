import { Aggregator } from '../../src/core/aggregator.js';
import { LogEntry } from '../../src/core/scanner.js';

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

  it('sets files scanned', () => {
    const agg = new Aggregator();
    agg.setFilesScanned(42);
    const result = agg.getResult('today', new Date(), new Date());
    expect(result.totals.files_scanned).toBe(42);
  });

  it('aggregates cache 5m and 1h separately', () => {
    const agg = new Aggregator();
    agg.add(makeEntry({ cache_5m_input_tokens: 500, cache_1h_input_tokens: 700 }));
    agg.add(makeEntry({ cache_5m_input_tokens: 300, cache_1h_input_tokens: 200 }));
    const result = agg.getResult('today', new Date(), new Date());
    expect(result.totals.cache_5m_input_tokens).toBe(800);
    expect(result.totals.cache_1h_input_tokens).toBe(900);
  });

  it('includes period info in result', () => {
    const agg = new Aggregator();
    const start = new Date('2026-03-01');
    const end = new Date('2026-03-22');
    const result = agg.getResult('this-month', start, end);
    expect(result.period.label).toBe('this-month');
    expect(result.period.start).toContain('2026-03-01');
    expect(result.period.end).toContain('2026-03-22');
  });
});
