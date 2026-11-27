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

const gate = { open: false };

class SlowPlanner extends StubMind {
  isPlanSettled(): boolean {
    return gate.open;
  }
}
const slowMind: CreateMind = (profile, deps) => new SlowPlanner(profile, deps);

function world(startAt: string, wakeUpTimeoutSec?: number) {
  const { engine, messages } = createSimTestWorld({
    startAt,
    createMind: slowMind,
    config: { sim: { villagers: 4, tickMs: 20 } },
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
        sim: { villagers: 10, tickMs: 50, wakeUpTimeoutSec: 120 },
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
