/** AC4: a door note is read on the owner's next home visit and the reply references its content. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DoorNote, GameMinutes } from '../../src/shared/types.ts';
import { at } from '../../src/shared/time.ts';
import { checkNote } from '../helpers/checks.ts';
import { ready, SIM_FEATURES, waitingFor } from '../helpers/features.ts';
import { awake, createTestWorld, type TestWorld } from '../helpers/world.ts';

const NOTE = 'Could you water the sunflowers by the fountain tomorrow morning?';

describe.skipIf(!ready(...SIM_FEATURES))(`AC4: door notes${waitingFor(...SIM_FEATURES)}`, () => {
  let w: TestWorld;
  let ownerId = '';
  let postedAt: GameMinutes = 0;
  let firstArrival: GameMinutes | null = null;
  let leftAgainAt: GameMinutes | null = null;
  const statusWhileAway = new Set<string>();
  let note: () => DoorNote | undefined;

  beforeAll(async () => {
    w = await createTestWorld({ villagers: 10, startAt: '06:00', seed: 11 });
    const away = await w.until(
      (tw) =>
        tw
          .state()
          .villagers.some(
            (v) => awake(v) && v.locationId !== tw.profile(v.id).homeId && v.locationId !== null,
          ),
      8 * 60,
    );
    if (!away) throw new Error('no villager left home by 14:00');
    const owner = w
      .state()
      .villagers.find((v) => awake(v) && v.locationId !== w.profile(v.id).homeId && v.locationId !== null)!;
    ownerId = owner.id;
    const homeId = w.profile(ownerId).homeId;
    postedAt = w.now();
    w.command({ type: 'note.post', houseId: homeId, text: NOTE });
    note = () => w.state().notes.find((n) => n.houseId === homeId && n.text === NOTE);
    let wasHome = false;
    let before = w.now();
    const sample = () => {
      const v = w.villager(ownerId);
      const home = v.locationId === homeId;
      // The mock replies within the arrival step, so the arrival counts from the start of that step.
      if (home && !wasHome && firstArrival === null) firstArrival = before;
      if (!home && wasHome && firstArrival !== null && leftAgainAt === null) leftAgainAt = w.now();
      if (firstArrival === null) statusWhileAway.add(note()?.status ?? 'missing');
      wasHome = home;
    };
    sample();
    const end = at(1, '02:00');
    while (w.now() < end && note()?.status !== 'replied') {
      before = w.now();
      await w.advance(1, { chunk: 1 });
      sample();
    }
  }, 300_000);

  afterAll(() => w?.dispose());

  it('creates the note on the owner door and broadcasts it', () => {
    expect(note()).toBeDefined();
    expect(note()!.ownerId).toBe(ownerId);
    expect(note()!.postedAt).toBe(postedAt);
    expect(w.of('note.updated').length).toBeGreaterThanOrEqual(1);
  });

  it('stays unread until the owner comes home', () => {
    expect(firstArrival).not.toBeNull();
    expect([...statusWhileAway]).toEqual(['unread']);
  });

  it('is read during that first visit home', () => {
    const n = note()!;
    expect(n.readAt).toBeDefined();
    expect(n.readAt!).toBeGreaterThanOrEqual(firstArrival!);
    if (leftAgainAt !== null) expect(n.readAt!).toBeLessThanOrEqual(leftAgainAt);
  });

  it('gets a reply that references the note', () => {
    const result = checkNote(note());
    expect(result.detail).toContain('shares');
    expect(result.pass).toBe(true);
    expect(w.memories(ownerId).some((m) => m.kind === 'note' && m.importance >= 7)).toBe(true);
  });
});
