import { afterEach, describe, expect, it } from 'vitest';
import { createMind } from '../../src/server/cognition/mind.ts';
import type { CreateMind } from '../../src/server/cognition/types.ts';
import { MockChatProvider, MockEmbeddingProvider } from '../../src/server/llm/providers/mock.ts';
import type { ChatProvider, EmbeddingProvider } from '../../src/server/llm/types.ts';
import type { Engine } from '../../src/server/sim/engine.ts';
import type { SimStatusMsg } from '../../src/shared/protocol.ts';
import { StubMind } from '../../src/server/sim/stub-mind.ts';
import { at } from '../../src/shared/time.ts';
import { createSimTestWorld } from '../helpers/sim.ts';

const gate = { open: false, ready: new Set<string>() };

class SlowPlanner extends StubMind {
  isPlanSettled(): boolean {
    return gate.open || gate.ready.has(this.id);
  }
}
const slowMind: CreateMind = (profile, deps) => new SlowPlanner(profile, deps);

function world(startAt: string, wakeUpTimeoutSec?: number, wakeUpMode: 'hold' | 'soft' | null = 'hold') {
  const { engine, messages } = createSimTestWorld({
    startAt,
    createMind: slowMind,
    config: { sim: { villagers: 4, tickMs: 20, ...(wakeUpMode ? { wakeUpMode } : {}) } },
  });
  if (wakeUpTimeoutSec !== undefined) engine.config.sim.wakeUpTimeoutSec = wakeUpTimeoutSec;
  const statuses = () => messages.filter((m): m is SimStatusMsg => m.type === 'sim.status');
  return { engine, statuses };
}

let running: Engine | undefined;
afterEach(() => {
  running?.stop();
  running = undefined;
  gate.open = false;
  gate.ready.clear();
});

describe('morning wake-up hold', () => {
  it('holds at 06:00 until plans settle, then runs', async () => {
    const { engine, statuses } = world('05:50');
    let opened = false;
    engine.onMessage((m) => {
      if (m.type === 'sim.status' && !opened) {
        opened = true;
        gate.open = true;
      }
    });
    await engine.advance(20, { drainLlm: true });
    expect(engine.now()).toBeCloseTo(at(0, '06:10'));
    expect(statuses().map((s) => s.phase)).toEqual(['wakingUp', 'running']);
    expect(statuses()[1]).toMatchObject({ plansReady: 4, villagers: 4 });
  });

  it('ends once no LLM work is left, keeping fallback plans', async () => {
    const { engine, statuses } = world('05:58');
    await engine.advance(5, { drainLlm: true });
    expect(engine.now()).toBeCloseTo(at(0, '06:03'));
    expect(statuses().at(-1)).toMatchObject({ phase: 'running', plansReady: 0 });
  });

  it('planStatus counts residents with a settled plan for the current day', async () => {
    const { engine } = world('05:50');
    expect(engine.planStatus()).toEqual({ ready: 0, total: 4 });
    gate.open = true;
    expect(engine.planStatus()).toEqual({ ready: 4, total: 4 });
  });

  it('only holds once per day', async () => {
    gate.open = true;
    const { engine, statuses } = world('05:00');
    await engine.advance(26 * 60, { drainLlm: true, step: 5 });
    expect(statuses()).toEqual([]);
  }, 20_000);

  it('real time: the clock stands still until the cap expires', async () => {
    const { engine, statuses } = world('06:00', 0.3);
    running = engine;
    const t0 = engine.now();
    engine.start();
    await new Promise((r) => setTimeout(r, 150));
    expect(engine.now()).toBe(t0);
    expect(statuses()[0]?.phase).toBe('wakingUp');
    await new Promise((r) => setTimeout(r, 400));
    expect(engine.now()).toBeGreaterThan(t0);
    expect(statuses().at(-1)?.phase).toBe('running');
  });

  it('a cap of 0 disables the hold', async () => {
    const { engine, statuses } = world('06:00', 0);
    running = engine;
    const t0 = engine.now();
    engine.start();
    await new Promise((r) => setTimeout(r, 150));
    expect(engine.now()).toBeGreaterThan(t0);
    expect(statuses()).toEqual([]);
  });
});

describe('wake-up hold with a slow real model', () => {
  it('waits for every plan even while embeddings and chat take seconds', async () => {
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const chat = new MockChatProvider('slow-model');
    const embed = new MockEmbeddingProvider();
    const slowChat: ChatProvider = {
      kind: chat.kind,
      model: chat.model,
      health: () => chat.health(),
      chat: async (req) => {
        await delay(5000);
        return chat.chat(req);
      },
    };
    const slowEmbed: EmbeddingProvider = {
      kind: embed.kind,
      model: embed.model,
      embed: async (texts) => {
        await delay(2000);
        return embed.embed(texts);
      },
    };
    const { engine, messages } = createSimTestWorld({
      startAt: '06:00',
      createMind,
      config: {
        sim: { villagers: 10, tickMs: 50, wakeUpMode: 'hold', wakeUpTimeoutSec: 120 },
        llm: { concurrency: 10 },
        embeddings: { provider: 'mock' },
      },
      providers: { chat: slowChat, embeddings: slowEmbed },
    });
    running = engine;
    const statuses = () => messages.filter((m): m is SimStatusMsg => m.type === 'sim.status');
    const t0 = engine.now();
    engine.start();
    await delay(4000);
    expect(engine.now()).toBe(t0);
    expect(statuses().at(-1)?.phase).toBe('wakingUp');
    const deadline = Date.now() + 40_000;
    while (statuses().at(-1)?.phase !== 'running' && Date.now() < deadline) await delay(100);
    expect(statuses().at(-1)).toMatchObject({ phase: 'running', plansReady: 10, villagers: 10 });
    await delay(300);
    expect(engine.now()).toBeGreaterThan(t0);
  }, 60_000);
});

describe('soft wake-up (wakeUpMode "soft")', () => {
  const soft = (startAt: string) => world(startAt, undefined, 'soft');

  it('is the default mode', () => {
    const { engine } = world('05:50', undefined, null);
    expect(engine.config.sim.wakeUpMode).toBe('soft');
  });

  it('keeps the clock running at 06:00 and reports planning, then running once', async () => {
    const { engine, statuses } = soft('05:50');
    await engine.advance(20, { drainLlm: true });
    expect(engine.now()).toBeCloseTo(at(0, '06:10'));
    expect(engine.wakingUp).toBe(false);
    expect(statuses()).toEqual([{ type: 'sim.status', phase: 'planning', plansReady: 0, villagers: 4 }]);
    gate.open = true;
    await engine.advance(5, { drainLlm: true });
    expect(engine.now()).toBeCloseTo(at(0, '06:15'));
    expect(statuses().map((s) => s.phase)).toEqual(['planning', 'running']);
    expect(statuses()[1]).toMatchObject({ plansReady: 4, villagers: 4 });
  });

  it('sends the count again each time another plan settles', async () => {
    const { engine, statuses } = soft('05:58');
    await engine.advance(5);
    for (const id of engine.profiles.map((p) => p.id)) {
      gate.ready.add(id);
      await engine.advance(1);
    }
    expect(statuses().map((s) => [s.phase, s.plansReady])).toEqual([
      ['planning', 0],
      ['planning', 1],
      ['planning', 2],
      ['planning', 3],
      ['running', 4],
    ]);
    await engine.advance(10);
    expect(statuses()).toHaveLength(5);
  });

  it('sends nothing on a morning when every plan is already settled', async () => {
    gate.open = true;
    const { engine, statuses } = soft('05:00');
    await engine.advance(26 * 60, { step: 5 });
    expect(statuses()).toEqual([]);
  }, 20_000);

  it('ends an unfinished day with running and starts again at the next 06:00', async () => {
    const { engine, statuses } = soft('05:50');
    await engine.advance(19 * 60, { step: 5 });
    expect(statuses().map((s) => s.phase)).toEqual(['planning', 'running']);
    await engine.advance(6 * 60 + 30, { step: 5 });
    expect(statuses().map((s) => s.phase)).toEqual(['planning', 'running', 'planning']);
  }, 20_000);

  it('ends with running when the model goes offline', async () => {
    const { engine, statuses } = soft('05:58');
    await engine.advance(5);
    engine.queue.isOnline = () => false;
    await engine.advance(1);
    expect(statuses().map((s) => s.phase)).toEqual(['planning', 'running']);
  });

  it('real time: the clock never stops, and the status repeats with the stats tick', async () => {
    const { engine, statuses } = soft('06:00');
    engine.config.sim.wakeUpTimeoutSec = 300;
    running = engine;
    const t0 = engine.now();
    engine.start();
    await new Promise((r) => setTimeout(r, 150));
    expect(engine.now()).toBeGreaterThan(t0);
    expect(statuses()).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 2300));
    expect(statuses().length).toBeGreaterThanOrEqual(2);
    expect(statuses().every((s) => s.phase === 'planning' && s.plansReady === 0)).toBe(true);
    gate.open = true;
    await new Promise((r) => setTimeout(r, 150));
    expect(statuses().at(-1)).toMatchObject({ phase: 'running', plansReady: 4, villagers: 4 });
  });
});
