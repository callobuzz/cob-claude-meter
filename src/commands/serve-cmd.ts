import { ConfigManager } from '../core/config-manager.js';
import { discoverLogPaths } from '../core/path-resolver.js';
import { TagStore } from '../core/tag-store.js';
import { TimelineCache } from '../core/timeline-cache.js';
import { startDashboardServer } from '../server/server.js';

export interface ServeFlags {
  port?: string;
  host?: string;
  dataDir?: string;
}

export interface RunningServer {
  url: string;
  close: () => Promise<void>;
}

/** Returns the running server so callers can shut it down; null if it could not start. */
export async function runServeCommand(flags: ServeFlags): Promise<RunningServer | null> {
  const configManager = new ConfigManager(flags.dataDir ?? process.env['CLAUDE_METER_DATA_DIR']);
  const config = configManager.load();

  // Env vars win so a container can be configured without a config file.
  const envPaths = (process.env['CLAUDE_METER_LOG_PATHS'] ?? '')
    .split(/[;:](?![\\/])/)
    .map(p => p.trim())
    .filter(Boolean);

  const logPaths = envPaths.length > 0
    ? envPaths
    : config.logPaths.length > 0
      ? config.logPaths
      : discoverLogPaths();

  if (logPaths.length === 0) {
    console.error('No Claude Code log directories found.');
    console.error('Set one with:  claude-meter config --set logPaths=\'["/path/to/logs"]\'');
    console.error('Or in Docker:  CLAUDE_METER_LOG_PATHS=/logs');
    process.exitCode = 1;
    return null;
  }

  const dataDir = configManager.getConfigDir();
  const tags = new TagStore(dataDir).load();
  const cache = new TimelineCache(dataDir);
  cache.load();
  cache.sweepTempFiles();

  const port = Number(flags.port ?? process.env['PORT'] ?? 4317);
  const host = flags.host ?? process.env['HOST'] ?? '127.0.0.1';

  const { url, close } = await startDashboardServer({
    port,
    host,
    logPaths,
    tags,
    cache,
    reportTtlMs: 15_000,
  });

  console.log('');
  console.log(`  Claude Meter dashboard  ${url}`);
  console.log('');
  console.log(`  logs   ${logPaths.join('\n         ')}`);
  console.log(`  data   ${dataDir}`);
  console.log('');
  console.log('  Ctrl+C to stop');
  console.log('');

  return { url, close };
}
