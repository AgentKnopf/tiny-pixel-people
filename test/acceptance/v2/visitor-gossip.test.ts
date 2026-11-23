/** AC13: a distinctive fact told to a visitor spreads to residents through gossip. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { at, dayOf } from '../../../src/shared/time.ts';
import type { VillagerId } from '../../../src/shared/types.ts';
import { gossipMentions } from '../../helpers/checks.ts';
import { readyV2, waitingForV2 } from '../../helpers/features.ts';
import { V2, visitorsInTown } from '../../helpers/v2.ts';
import { createTestWorld, type TestWorld } from '../../helpers/world.ts';

const F = [...V2.visitors];
const FACT = 'My aunt in Copperfield keeps a blue llama called Zigzag.';
const KEYWORD = 'Zigzag';
const INJECT_AT = at(1, '09:00');
const BY = at(1, '20:00');

describe.skipIf(!readyV2(...F))(`AC13: visitors gossip${waitingForV2(...F)}`, () => {
  let w: TestWorld;
  let visitorId: VillagerId = '';
  const residents = new Set<VillagerId>();

  beforeAll(async () => {
    w = await createTestWorld({ villagers: 12, seed: 13, startAt: '06:00' });
    for (const v of w.state().villagers) residents.add(v.id);
    await w.advanceTo(INJECT_AT);
    const inTown = visitorsInTown(w.state()).filter((v) => v.departsAt > BY);
    // The visitor's first full day: arrived on day 0, still here all of day 1.
    const pick = inTown.find((v) => dayOf(v.arrivedAt) === 0 && v.status === 'checkedIn') ?? inTown[0];
    if (!pick) throw new Error('no visitor in town on day 1 at 09:00 who stays until 20:00');
    visitorId = pick.villagerId;
    w.command({ type: 'debug.inject', villagerId: visitorId, text: FACT, importance: 8 });
    await w.advanceTo(BY);
  }, 600_000);

  afterAll(() => w?.dispose());

  it('the visitor is not a resident and holds the fact', () => {
    expect(residents.has(visitorId)).toBe(false);
    const added = w.of('villagers.changed').flatMap((m) => m.added);
    expect(added.find((p) => p.id === visitorId)?.visitor).toBe(true);
    expect(w.memories(visitorId).some((m) => m.text.includes(KEYWORD))).toBe(true);
  });

  it('a resident other than the visitor says it by 20:00', () => {
    const hits = gossipMentions(w.of('conversation.message'), KEYWORD, visitorId, INJECT_AT, BY).filter((m) =>
      residents.has(m.speakerId),
    );
    expect(hits.length, `no resident said "${KEYWORD}"`).toBeGreaterThan(0);
  });

  it('a resident has a memory with the fact originId, heard from the visitor', () => {
    const source = w.memories(visitorId).find((m) => m.text.includes(KEYWORD))!;
    const origin = source.meta.originId ?? source.id;
    const heard = [...residents].flatMap((id) =>
      w.memories(id).filter((m) => m.meta.originId === origin && m.meta.heardFrom === visitorId),
    );
    expect(heard.length).toBeGreaterThanOrEqual(1);
    expect(heard[0]!.villagerId).not.toBe(visitorId);
  });
});
