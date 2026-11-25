/** A restored save is not kept alive by the engine once its data has been taken over. */
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { createMind } from '../../src/server/cognition/mind.ts';
import { MockChatProvider } from '../../src/server/llm/providers/mock.ts';
import { createSimEngine, type Engine } from '../../src/server/sim/engine.ts';
import { createSimTestWorld } from '../helpers/sim.ts';

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;

async function collected(ref: WeakRef<object>): Promise<boolean> {
  for (let i = 0; i < 10 && ref.deref(); i++) {
    await new Promise((r) => setTimeout(r, 0));
    gc();
  }
  return ref.deref() === undefined;
}

/** Restores a fresh engine from a save that only this function's scope holds. */
async function restoreFromSave(): Promise<{
  engine: Engine;
  villagers: number;
  saveRef: WeakRef<object>;
  memoryRef: WeakRef<object>;
}> {
  const { engine: first } = createSimTestWorld({ startAt: '09:00', createMind });
  await first.advance(60);
  const save = structuredClone(first.toSaveData());
  first.stop();
  const engine = createSimEngine({
    config: first.config,
    providers: { chat: new MockChatProvider(), embeddings: null },
    createMind,
    restore: save,
  });
  return {
    engine,
    villagers: save.villagers.length,
    saveRef: new WeakRef(save),
    memoryRef: new WeakRef(save.minds.find((m) => m.memories.length > 0)!.memories[0]!),
  };
}

describe('restored save', () => {
  it('is not reachable from the engine after the restore', async () => {
    const { engine, villagers, saveRef, memoryRef } = await restoreFromSave();
    await engine.advance(5);
    expect(engine.snapshot().villagers).toHaveLength(villagers);
    expect(await collected(saveRef)).toBe(true);
    // The mind keeps its own copies of the memories, not the saved ones.
    expect(await collected(memoryRef)).toBe(true);
    engine.stop();
  });
});
