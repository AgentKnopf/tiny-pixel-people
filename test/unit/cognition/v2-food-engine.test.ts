/** Hunger overrides send hungry villagers, including a hotel guest, to food close by (spec §7.10). */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { VillagerProfile } from '../../../src/shared/types.ts';
import { ready, SIM_FEATURES, waitingFor } from '../../helpers/features.ts';
import { createTestWorld } from '../../helpers/world.ts';

const FEATURES = [...SIM_FEATURES, 'needs'] as const;
const FOOD = /eat|lunch|breakfast|dinner|bite|snack|food|meal|bread|coffee|cake|ice cream/i;
const RESIDENTS = JSON.parse(
  readFileSync(new URL('../../../data/villagers.json', import.meta.url), 'utf8'),
) as VillagerProfile[] | { villagers: VillagerProfile[] } as
  VillagerProfile[] | { villagers: VillagerProfile[] };
const residents = (Array.isArray(RESIDENTS) ? RESIDENTS : RESIDENTS.villagers).slice(0, 5);
const GUEST: VillagerProfile = {
  id: 'guest',
  name: 'Gus',
  age: 35,
  occupation: 'Travelling photographer',
  bio: 'Gus came by train and is staying at the hotel for a few days.',
  traits: ['curious'],
  homeId: 'hotel',
  sprite: residents[0]!.sprite,
  wakeTime: '07:00',
  sleepTime: '22:00',
  transient: true,
};

describe.skipIf(!ready(...FEATURES))(`hunger override near food${waitingFor(...FEATURES)}`, () => {
  it('a hotel guest and the residents eat within 60 minutes of getting hungry, and eating stops the decline', async () => {
    const w = await createTestWorld({
      profiles: [...residents, GUEST],
      villagers: residents.length + 1,
      startAt: '07:00',
      config: { needs: { decayPerHour: { hunger: 45, energy: 4, social: 5, fun: 4 } } },
    });
    const hungrySince = new Map<string, number>();
    const ateAt = new Map<string, number>();
    const hungerAt = new Map<string, number>();
    /** Villagers whose hunger kept falling while they ate (eating must restore at least the decay). */
    const starving = new Set<string>();
    await w.advanceTo('15:00', {
      chunk: 2,
      onStep: ({ time, snapshot }) => {
        for (const v of snapshot().villagers) {
          if (v.status === 'sleeping') continue;
          if (v.needs.hunger < 20 && !hungrySince.has(v.id)) hungrySince.set(v.id, time);
          const since = hungrySince.get(v.id);
          if (since === undefined) continue;
          if (!ateAt.has(v.id) && v.status !== 'walking' && FOOD.test(v.activity.text)) {
            ateAt.set(v.id, time);
            hungerAt.set(v.id, v.needs.hunger);
          }
          const a = ateAt.get(v.id);
          if (
            a !== undefined &&
            time - a <= 20 &&
            FOOD.test(v.activity.text) &&
            v.needs.hunger < hungerAt.get(v.id)! - 1
          )
            starving.add(v.id);
        }
      },
    });
    w.dispose();
    expect(hungrySince.has('guest')).toBe(true);
    const late = [...hungrySince].filter(([id, t]) => !ateAt.has(id) || ateAt.get(id)! - t > 60);
    expect(late, JSON.stringify(late)).toEqual([]);
    expect([...starving]).toEqual([]);
  }, 180_000);
});
