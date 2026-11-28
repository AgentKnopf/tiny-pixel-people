/** TASK-18 I3: weather influence end to end through HTTP and the real engine (spec §4.5, AC9, AC4). */
import { afterEach, describe, expect, it } from 'vitest';
import { startServer } from '../../../src/server/net/server.ts';
import type { Engine } from '../../../src/server/sim/engine.ts';
import type { WeatherOutcomes } from '../../../src/shared/influence.ts';
import { createSimTestWorld } from '../../helpers/sim.ts';

const TOKEN = 'influence-weather-token-0123456789abcdef';
const HEADERS = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
const CONFIG = { influence: { enabled: true, token: TOKEN } };

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

async function boot(engine: Engine) {
  const server = await startServer({
    host: '127.0.0.1',
    port: 0,
    staticDir: 'dist/client',
    debug: false,
    llm: { provider: 'mock', model: 'mock-model', embeddings: null },
    engine,
    observer: { config: engine.config.observer, source: engine },
    influence: { config: engine.config.influence },
  });
  closers.push(() => server.close());
  const base = `http://127.0.0.1:${server.port}/api/influence`;
  return {
    post: async (body: unknown) => {
      const r = await fetch(`${base}/weather`, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify(body),
      });
      return { status: r.status, json: (await r.json()) as Record<string, unknown> };
    },
    log: async () => {
      const r = await fetch(`${base}/log`, { headers: HEADERS });
      return (await r.json()) as { entries: { outcomes: WeatherOutcomes; refs: Record<string, string> }[] };
    },
  };
}

describe('POST /api/influence/weather', () => {
  it('rain 2 h, 409 while raining with no budget used, hours 4 is 400, clear and 409 not_raining', async () => {
    const { engine } = createSimTestWorld({ config: CONFIG, startAt: '09:00' });
    const api = await boot(engine);
    const now = engine.now();

    const ok = await api.post({ weather: 'rain', hours: 2 });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ id: 'inf_1', tick: now, refs: { worldEventId: expect.any(String) } });
    expect(engine.playerWorld.weather).toMatchObject({ state: 'rain', until: now + 120 });

    expect((await api.post({ weather: 'rain', hours: 4 })).status).toBe(400);
    const again = await api.post({ weather: 'rain', hours: 1 });
    expect(again).toEqual({ status: 409, json: { error: 'already_raining' } });
    expect(engine.influence.budget().usedToday).toBe(1);

    expect((await api.post({ weather: 'clear' })).status).toBe(200);
    expect(engine.playerWorld.weather.state).toBe('clear');
    expect(await api.post({ weather: 'clear' })).toEqual({ status: 409, json: { error: 'not_raining' } });
    expect(engine.influence.budget().usedToday).toBe(2);

    const { entries } = await api.log();
    expect(entries.map((e) => e.outcomes)).toEqual([
      { startedAt: now, endedAt: now, swaps: expect.any(Number) },
      { endedAt: now, swaps: 0 },
    ]);
  });

  it('a restored game resumes its weather influence: the rain end lands on the saved entry', async () => {
    const a = createSimTestWorld({ config: CONFIG, startAt: '09:00' });
    const start = a.engine.now();
    expect(a.engine.applyInfluence({ endpoint: 'weather', body: { weather: 'rain', hours: 1 } }).ok).toBe(
      true,
    );
    await a.engine.advance(10);
    const save = structuredClone(a.engine.toSaveData());

    const b = createSimTestWorld({ config: CONFIG, restore: save });
    expect(b.engine.playerWorld.weather.state).toBe('rain');
    await b.engine.advance(60);
    expect(b.engine.playerWorld.weather.state).toBe('clear');
    const [entry] = b.engine.influenceLog({}).entries;
    expect(entry!.outcomes).toMatchObject({ startedAt: start, endedAt: start + 60 });
  });
});
