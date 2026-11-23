import { loadConfig, redactConfig, resolveEmbeddingProvider, ConfigError, type AppConfig } from './config.ts';
import { createLogger } from './log.ts';
import { createProviders } from './llm/index.ts';
import { MockChatProvider } from './llm/providers/mock.ts';
import type { Providers } from './llm/types.ts';
import { startServer } from './net/server.ts';
import { createPlaceholderMap, createPlaceholderSnapshot } from './sim/placeholder.ts';
import { parseClock } from '../shared/time.ts';

const log = createLogger('main');

function parseArgs(argv: string[]): { configPath?: string; fresh: boolean } {
  const out: { configPath?: string; fresh: boolean } = { fresh: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config') out.configPath = argv[++i];
    else if (a === '--new') out.fresh = true;
  }
  return out;
}

function buildProviders(cfg: AppConfig): Providers {
  try {
    return createProviders(cfg);
  } catch (err) {
    // Skeleton only: real providers arrive with WP1.
    log.warn(`${(err as Error).message}; falling back to the mock provider`);
    return { chat: new MockChatProvider(cfg.llm.model), embeddings: null };
  }
}

async function main(): Promise<void> {
  if (typeof process.loadEnvFile === 'function') {
    try {
      process.loadEnvFile('.env');
    } catch {
      // No .env file: fine.
    }
  }
  const args = parseArgs(process.argv.slice(2));
  let cfg: AppConfig & { sourcePath: string | null };
  try {
    cfg = loadConfig(args.configPath ? { path: args.configPath } : {});
  } catch (err) {
    if (err instanceof ConfigError) {
      log.error(err.message);
      process.exit(1);
    }
    throw err;
  }
  log.info(`config: ${cfg.sourcePath ?? 'defaults (no config.json)'}`);
  log.debug('effective config', redactConfig(cfg));

  const providers = buildProviders(cfg);
  const health = await providers.chat.health();
  log[health.ok ? 'info' : 'warn'](`LLM ${providers.chat.kind}/${providers.chat.model}: ${health.message}`);

  const map = createPlaceholderMap();
  const startTime = parseClock(cfg.sim.startTime);
  const server = await startServer({
    host: cfg.server.host,
    port: cfg.server.port,
    staticDir: 'dist/client',
    debug: cfg.debug,
    llm: {
      provider: providers.chat.kind,
      model: providers.chat.model,
      embeddings: providers.embeddings
        ? `${resolveEmbeddingProvider(cfg)}/${providers.embeddings.model}`
        : null,
    },
    getMap: () => map,
    getSnapshot: () => createPlaceholderSnapshot(startTime, cfg.sim.speed, cfg.player.name),
  });
  log.info(`Tiny Pixel People running at ${server.url}`);

  const shutdown = async (signal: string) => {
    log.info(`${signal} received, shutting down`);
    await server.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  log.error('fatal', err);
  process.exit(1);
});
