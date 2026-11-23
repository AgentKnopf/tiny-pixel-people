/** §14.1 Rumor tracker: a rumor told to A at 08:00 has >= 2 hops and >= 3 knowers by 20:00. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RumorUpdatedMsg } from '../../src/shared/protocol.ts';
import { PLAYER_ID, type Rumor } from '../../src/shared/types.ts';
import { ready, SIM_FEATURES, waitingFor } from '../helpers/features.ts';
import { awake, createTestWorld, type TestWorld } from '../helpers/world.ts';

const FEATURES = [...SIM_FEATURES, 'player', 'rumors'] as const;
const TEXT = 'The old well behind the farm is full of gold coins.';

describe.skipIf(!ready(...FEATURES))(`§14.1 rumor tracker${waitingFor(...FEATURES)}`, () => {
  let w: TestWorld;
  let a = '';
  let rumor: () => Rumor | undefined;

  beforeAll(async () => {
    w = await createTestWorld({ villagers: 10, startAt: '06:00', seed: 5 });
    await w.advanceTo('08:00');
    a = w.state().villagers.find(awake)!.id;
    w.command({ type: 'player.rumor', villagerId: a, text: TEXT });
    rumor = () => w.state().rumors.find((r) => r.startedBy === PLAYER_ID && r.text.includes('gold coins'));
    await w.advanceTo('20:00');
  }, 300_000);

  afterAll(() => w?.dispose());

  it('starts a rumor known by A, backed by a heard memory', () => {
    const r = rumor();
    expect(r).toBeDefined();
    expect(r!.knownBy).toContain(a);
    const m = w.memories(a).find((x) => x.id === r!.originMemoryId || x.meta.originId === r!.originMemoryId);
    expect(m?.kind).toBe('heard');
    expect(m?.meta.heardFrom).toBe(PLAYER_ID);
  });

  it('spreads with >= 2 hops and >= 3 villagers knowing by 20:00', () => {
    const r = rumor()!;
    expect(r.hops.length).toBeGreaterThanOrEqual(2);
    expect(new Set(r.knownBy).size).toBeGreaterThanOrEqual(3);
  });

  it('records hops that reference real conversations and memories', () => {
    const r = rumor()!;
    const convos = new Map(w.conversations().map((c) => [c.id, c]));
    for (const hop of r.hops) {
      expect(hop.from).not.toBe(hop.to);
      expect(hop.text).toBeTruthy();
      expect(r.knownBy).toContain(hop.to);
      if (hop.conversationId) {
        const c = convos.get(hop.conversationId);
        expect(c, hop.conversationId).toBeDefined();
        expect(c!.participants).toEqual(expect.arrayContaining([hop.from, hop.to]));
      }
      expect(
        w.memories(hop.to).some((m) => m.meta.originId === r.originMemoryId),
        `${hop.to} memory`,
      ).toBe(true);
    }
    expect(r.hops.filter((h) => h.conversationId).length).toBeGreaterThanOrEqual(1);
  });

  it('broadcasts rumor.updated for the start and each hop', () => {
    const r = rumor()!;
    const updates = (w.of('rumor.updated') as RumorUpdatedMsg[]).filter((m) => m.rumor.id === r.id);
    expect(updates.length).toBeGreaterThanOrEqual(r.hops.length + 1);
  });
});
