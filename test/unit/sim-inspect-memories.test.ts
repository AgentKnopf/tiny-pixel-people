/** The inspector's memory list: the newest 10 unarchived memories, without copying a big stream. */
import { describe, expect, it } from 'vitest';
import { createMind } from '../../src/server/cognition/mind.ts';
import type { VillagerMind } from '../../src/server/cognition/types.ts';
import type { InspectDataMsg } from '../../src/shared/protocol.ts';
import { StubMind } from '../../src/server/sim/stub-mind.ts';
import { createSimTestWorld } from '../helpers/sim.ts';

const MEMORIES = 500;

/** Mia gets MEMORIES memories (every third archived, two out of time order); counts serialize() calls. */
function world(make: (mind: StubMind) => VillagerMind = (m) => m) {
  let serializeCalls = 0;
  const { engine } = createSimTestWorld({
    startAt: '09:00',
    createMind: (profile, deps) => {
      const stub = new StubMind(profile, deps);
      if (profile.id !== 'mia') return stub;
      for (let i = 0; i < MEMORIES; i++)
        stub.observe({ at: 100 + i, kind: 'observation', text: `thing ${i}` });
      const list = (stub as unknown as { memoryList: { createdAt: number; meta: Record<string, unknown> }[] })
        .memoryList;
      list.forEach((m, i) => {
        if (i % 3 === 0) m.meta.archived = true;
      });
      list.at(-2)!.createdAt = 50; // late entry for an old moment
      const mind = make(stub);
      const serialize = mind.serialize.bind(mind);
      mind.serialize = () => {
        serializeCalls++;
        return serialize();
      };
      return mind;
    },
  });
  const inspect = () => {
    const before = serializeCalls;
    const [msg] = engine.handleCommand({ type: 'inspect', villagerId: 'mia' });
    return { msg: msg as InspectDataMsg, serialized: serializeCalls - before };
  };
  return { engine, inspect };
}

/** The last 10 unarchived memories recorded, newest first. */
function expected(mind: VillagerMind): string[] {
  return mind
    .serialize()
    .memories.filter((m) => !m.meta.archived)
    .slice(-10)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((m) => m.id);
}

describe('inspector memories', () => {
  it('lists the last 10 unarchived memories, newest first, without serializing the mind', () => {
    let stub: StubMind | null = null;
    const { engine, inspect } = world((m) => (stub = m));
    const { msg, serialized } = inspect();
    expect(serialized).toBe(0);
    expect(msg.memories.map((m) => m.id)).toEqual(expected(stub!));
    expect(msg.memories).toHaveLength(10);
    expect(msg.memories.every((m) => !m.meta.archived && !('embedding' in m))).toBe(true);
    const times = msg.memories.map((m) => m.createdAt);
    expect(times).toEqual([...times].sort((a, b) => b - a));
    // A memory recorded late for an older moment still counts as recent, listed last.
    expect(times.at(-1)).toBe(50);
    engine.stop();
  });

  it('falls back to serialize() for a mind without recentMemories, with the same list', () => {
    const a = world();
    const fast = a.inspect().msg.memories.map((m) => m.id);
    a.engine.stop();
    const b = world((stub) => {
      const plain: VillagerMind = Object.create(stub);
      Object.defineProperty(plain, 'recentMemories', { value: undefined });
      return plain;
    });
    const { msg, serialized } = b.inspect();
    expect(serialized).toBe(1);
    expect(msg.memories.map((m) => m.id)).toEqual(fast);
    b.engine.stop();
  });

  it('shows the same list as before for the real mind', async () => {
    const minds = new Map<string, VillagerMind>();
    const { engine } = createSimTestWorld({
      startAt: '09:00',
      createMind: (p, d) => {
        const m = createMind(p, d);
        minds.set(p.id, m);
        return m;
      },
    });
    await engine.advance(120);
    for (const id of ['mia', 'tom']) {
      const [msg] = engine.handleCommand({ type: 'inspect', villagerId: id });
      expect((msg as InspectDataMsg).memories.map((m) => m.id)).toEqual(expected(minds.get(id)!));
    }
    engine.stop();
  });
});
