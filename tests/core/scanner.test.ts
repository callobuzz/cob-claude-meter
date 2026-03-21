import { scanFile, LogEntry } from '../../src/core/scanner.js';
import { join } from 'node:path';

const FIXTURE_PATH = join(__dirname, '..', 'fixtures', 'sample.jsonl');

describe('scanFile', () => {
  it('parses valid assistant entries with usage', async () => {
    const entries: LogEntry[] = [];
    await scanFile(FIXTURE_PATH, (entry) => entries.push(entry));
    expect(entries).toHaveLength(3);
  });

  it('extracts correct token fields', async () => {
    const entries: LogEntry[] = [];
    await scanFile(FIXTURE_PATH, (entry) => entries.push(entry));
    const first = entries[0];
    expect(first.input_tokens).toBe(100);
    expect(first.output_tokens).toBe(200);
    expect(first.cache_read_input_tokens).toBe(5000);
    expect(first.cache_creation_input_tokens).toBe(3000);
    expect(first.cache_5m_input_tokens).toBe(1000);
    expect(first.cache_1h_input_tokens).toBe(2000);
  });

  it('extracts model', async () => {
    const entries: LogEntry[] = [];
    await scanFile(FIXTURE_PATH, (entry) => entries.push(entry));
    expect(entries[0].model).toBe('claude-opus-4-6');
    expect(entries[1].model).toBe('claude-haiku-4-5-20251001');
  });

  it('extracts timestamp as Date', async () => {
    const entries: LogEntry[] = [];
    await scanFile(FIXTURE_PATH, (entry) => entries.push(entry));
    expect(entries[0].timestamp).toBeInstanceOf(Date);
  });

  it('skips invalid JSON lines', async () => {
    const entries: LogEntry[] = [];
    const stats = await scanFile(FIXTURE_PATH, (entry) => entries.push(entry));
    expect(stats.skippedLines).toBeGreaterThan(0);
  });

  it('skips entries without usage', async () => {
    const entries: LogEntry[] = [];
    await scanFile(FIXTURE_PATH, (entry) => entries.push(entry));
    expect(entries).toHaveLength(3);
  });

  it('extracts web search/fetch counts', async () => {
    const entries: LogEntry[] = [];
    await scanFile(FIXTURE_PATH, (entry) => entries.push(entry));
    expect(entries[0].web_searches).toBe(1);
    expect(entries[1].web_fetches).toBe(1);
  });

  it('extracts sessionId', async () => {
    const entries: LogEntry[] = [];
    await scanFile(FIXTURE_PATH, (entry) => entries.push(entry));
    expect(entries[0].sessionId).toBe('sess-001');
  });

  it('filters by date range', async () => {
    const entries: LogEntry[] = [];
    const dateFilter = {
      start: new Date('2026-03-22T00:00:00Z'),
      end: new Date('2026-03-22T23:59:59Z'),
    };
    await scanFile(FIXTURE_PATH, (entry) => entries.push(entry), dateFilter);
    expect(entries).toHaveLength(2); // Only Mar 22 entries, not Mar 21
  });
});
