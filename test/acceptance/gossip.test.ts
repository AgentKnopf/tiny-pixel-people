/** AC3: a fact told to villager A in the morning is mentioned by another villager by evening. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConversationMessageMsg } from '../../src/shared/protocol.ts';
import { at } from '../../src/shared/time.ts';
import { checkGossip } from '../helpers/checks.ts';
import { ready, SIM_FEATURES, waitingFor } from '../helpers/features.ts';
import { awake, createTestWorld, type TestWorld } from '../helpers/world.ts';

const FACT = "The mayor's cat is named Biscuit.";

describe.skipIf(!ready(...SIM_FEATURES))(`AC3: gossip spreads${waitingFor(...SIM_FEATURES)}`, () => {
  let w: TestWorld;
  let sourceId: string;

  beforeAll(async () => {
    w = await createTestWorld({ villagers: 10, startAt: '06:00', seed: 7 });
    await w.advanceTo('08:00');
    const a = w.state().villagers.find(awake);
    if (!a) throw new Error('nobody is awake at 08:00');
    sourceId = a.id;
    w.command({ type: 'debug.inject', villagerId: sourceId, text: FACT, importance: 8 });
    await w.advanceTo('20:00');
  }, 300_000);

  afterAll(() => w?.dispose());

  it('stores the injected fact in A', () => {
    expect(w.memories(sourceId).some((m) => m.text.includes('Biscuit'))).toBe(true);
  });

  it('another villager says it in a conversation by 20:00', () => {
    const msgs = w.of('conversation.message') as ConversationMessageMsg[];
    const result = checkGossip(msgs, 'Biscuit', sourceId, at(0, '08:00'), at(0, '20:00'));
    expect(result.detail).toBe(result.pass ? result.detail : 'gossip spread');
    expect(result.pass).toBe(true);
  });

  it('traces the fact by originId to at least one other villager', () => {
    const source = w.memories(sourceId).find((m) => m.text.includes('Biscuit'))!;
    const origin = source.meta.originId ?? source.id;
    const others = w
      .state()
      .villagers.filter((v) => v.id !== sourceId)
      .filter((v) => w.memories(v.id).some((m) => m.meta.originId === origin && m.kind === 'heard'));
    expect(others.length).toBeGreaterThanOrEqual(1);
    const heard = w.memories(others[0]!.id).find((m) => m.meta.originId === origin)!;
    expect(heard.meta.heardFrom).toBeTruthy();
    expect(heard.meta.heardFrom).not.toBe(others[0]!.id);
  });
});
