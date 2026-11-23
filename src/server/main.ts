import { loadConfig, redactConfig, resolveEmbeddingProvider, ConfigError, type AppConfig } from './config.ts';
import { createLogger } from './log.ts';
import { checkLlmHealth, createProviders } from './llm/index.ts';
import { startServer } from './net/server.ts';
import { installShutdownSave, JsonSaveStore, type SaveData } from './persistence/index.ts';
import { createSimEngine } from './sim/engine.ts';
import { WorldDataError } from './sim/world.ts';

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

  const providers = createProviders(cfg);

  let restore: SaveData | undefined;
  if (cfg.persistence.loadOnStart && !args.fresh) {
    const store = new JsonSaveStore({ dir: cfg.persistence.dir, slot: cfg.persistence.slot });
    try {
      restore = (await store.load()) ?? undefined;
      if (restore) log.info(`resuming save "${cfg.persistence.slot}" from ${store.slotDir}`);
    } catch (err) {
      log.error(`could not load save "${cfg.persistence.slot}": ${(err as Error).message}`);
    }
  }
  if (!restore) log.info(`starting new world (save "${cfg.persistence.slot}")`);

  let engine;
  try {
    engine = createSimEngine({ config: cfg, providers, ...(restore ? { restore } : {}) });
  } catch (err) {
    if (err instanceof WorldDataError) {
      log.error(err.message);
      process.exit(1);
    }
    throw err;
  }
  const health = await checkLlmHealth(providers, engine.queue);
  log[health.chat.ok ? 'info' : 'warn'](
    `LLM ${providers.chat.kind}/${providers.chat.model}: ${health.chat.message}`,
  );
  if (health.embeddings)
    log[health.embeddings.ok ? 'info' : 'warn'](`embeddings: ${health.embeddings.message}`);
  log.info(`world: ${engine.map.width}x${engine.map.height} tiles, ${engine.profiles.length} villagers`);
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
    engine,
    replayFile: () => engine.store.replayPath,
  });
  engine.start();
  log.info(`Tiny Pixel People running at ${server.url}`);

  installShutdownSave(
    () => {
      engine.stop();
      return engine.saveNow();
    },
    async () => {
      await server.close();
      process.exit(0);
    },
  );
}

main().catch((err: unknown) => {
  log.error('fatal', err);
  process.exit(1);
});
