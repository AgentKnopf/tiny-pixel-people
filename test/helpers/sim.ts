import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type AppConfig, type PartialConfig } from '../../src/server/config.ts';
import { MockChatProvider } from '../../src/server/llm/providers/mock.ts';
import { createSimEngine, type Engine } from '../../src/server/sim/engine.ts';
import { createStubMind } from '../../src/server/sim/stub-mind.ts';
import type { SimEngineOptions } from '../../src/server/sim/types.ts';
import type { ServerMessage } from '../../src/shared/protocol.ts';
import { at } from '../../src/shared/time.ts';

/** Mock provider, debug on, no autosave and saves in a fresh temp dir. */
export function testConfig(overrides: PartialConfig = {}): AppConfig {
  const dir = mkdtempSync(join(tmpdir(), 'tpp-sim-'));
  const { sourcePath: _ignored, ...cfg } = loadConfig({
    env: {},
    cwd: dir,
    overrides: {
      llm: { provider: 'mock' },
      embeddings: { provider: 'none' },
      debug: true,
      ...overrides,
      persistence: {
        dir: join(dir, 'saves'),
        loadOnStart: false,
        autosaveGameMinutes: 0,
        ...overrides.persistence,
      },
    },
  });
  return cfg;
}

/** Engine with the stub mind, the mock provider and a virtual clock (nothing runs until advance()). */
export function createSimTestWorld(
  opts: { config?: PartialConfig; startAt?: string } & Omit<
    Partial<SimEngineOptions>,
    'config' | 'startAt'
  > = {},
): { engine: Engine; messages: ServerMessage[] } {
  const { config, startAt, ...rest } = opts;
  const engine = createSimEngine({
    config: testConfig(config),
    providers: { chat: new MockChatProvider(), embeddings: null },
    createMind: createStubMind,
    startAt: at(0, startAt ?? '06:00'),
    ...rest,
  });
  const messages: ServerMessage[] = [];
  engine.onMessage((m) => messages.push(m));
  return { engine, messages };
}
