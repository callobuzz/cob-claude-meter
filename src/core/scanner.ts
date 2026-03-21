import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

export interface LogEntry {
  timestamp: Date;
  model: string;
  sessionId: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  cache_5m_input_tokens: number;
  cache_1h_input_tokens: number;
  web_searches: number;
  web_fetches: number;
}

export interface ScanStats {
  linesRead: number;
  skippedLines: number;
  entriesMatched: number;
}

export async function scanFile(
  filePath: string,
  onEntry: (entry: LogEntry) => void,
  dateFilter?: { start: Date; end: Date },
): Promise<ScanStats> {
  const stats: ScanStats = { linesRead: 0, skippedLines: 0, entriesMatched: 0 };

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    stats.linesRead++;
    try {
      const json = JSON.parse(line);
      if (json.type !== 'assistant') continue;
      if (!json.message?.usage) continue;
      if (!json.timestamp) continue;

      const ts = new Date(json.timestamp);
      if (isNaN(ts.getTime())) continue;

      if (dateFilter) {
        if (ts < dateFilter.start || ts > dateFilter.end) continue;
      }

      const usage = json.message.usage;
      const cacheCreation = usage.cache_creation ?? {};
      const serverTools = usage.server_tool_use ?? {};

      const entry: LogEntry = {
        timestamp: ts,
        model: json.message.model ?? 'unknown',
        sessionId: json.sessionId ?? 'unknown',
        input_tokens: usage.input_tokens ?? 0,
        output_tokens: usage.output_tokens ?? 0,
        cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
        cache_5m_input_tokens: cacheCreation.ephemeral_5m_input_tokens ?? 0,
        cache_1h_input_tokens: cacheCreation.ephemeral_1h_input_tokens ?? 0,
        web_searches: serverTools.web_search_requests ?? 0,
        web_fetches: serverTools.web_fetch_requests ?? 0,
      };

      stats.entriesMatched++;
      onEntry(entry);
    } catch {
      stats.skippedLines++;
    }
  }

  return stats;
}
