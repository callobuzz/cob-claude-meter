import { LogEntry } from './scanner.js';

export interface ModelTokens {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  cache_5m_input_tokens: number;
  cache_1h_input_tokens: number;
  web_searches: number;
  web_fetches: number;
  entries_matched: number;
}

export interface TokenTotals extends ModelTokens {
  fresh_total: number;
  full_total: number;
  sessions: number;
  files_scanned: number;
}

export interface AggregationResult {
  period: {
    label: string;
    start: string;
    end: string;
  };
  totals: TokenTotals;
  by_model: Record<string, ModelTokens>;
}

function emptyModelTokens(): ModelTokens {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_5m_input_tokens: 0,
    cache_1h_input_tokens: 0,
    web_searches: 0,
    web_fetches: 0,
    entries_matched: 0,
  };
}

function addToTokens(target: ModelTokens, entry: LogEntry): void {
  target.input_tokens += entry.input_tokens;
  target.output_tokens += entry.output_tokens;
  target.cache_read_input_tokens += entry.cache_read_input_tokens;
  target.cache_creation_input_tokens += entry.cache_creation_input_tokens;
  target.cache_5m_input_tokens += entry.cache_5m_input_tokens;
  target.cache_1h_input_tokens += entry.cache_1h_input_tokens;
  target.web_searches += entry.web_searches;
  target.web_fetches += entry.web_fetches;
  target.entries_matched++;
}

export class Aggregator {
  private totals: ModelTokens = emptyModelTokens();
  private byModel: Record<string, ModelTokens> = {};
  private sessionIds = new Set<string>();
  private filesScanned = 0;

  add(entry: LogEntry): void {
    addToTokens(this.totals, entry);
    this.sessionIds.add(entry.sessionId);

    if (!this.byModel[entry.model]) {
      this.byModel[entry.model] = emptyModelTokens();
    }
    addToTokens(this.byModel[entry.model], entry);
  }

  setFilesScanned(count: number): void {
    this.filesScanned = count;
  }

  getResult(label: string, start: Date, end: Date): AggregationResult {
    const t = this.totals;
    return {
      period: {
        label,
        start: start.toISOString(),
        end: end.toISOString(),
      },
      totals: {
        ...t,
        fresh_total: t.input_tokens + t.output_tokens,
        full_total:
          t.input_tokens +
          t.output_tokens +
          t.cache_read_input_tokens +
          t.cache_creation_input_tokens,
        sessions: this.sessionIds.size,
        files_scanned: this.filesScanned,
      },
      by_model: this.byModel,
    };
  }
}
