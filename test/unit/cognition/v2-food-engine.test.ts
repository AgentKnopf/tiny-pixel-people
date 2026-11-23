/** Hunger overrides send hungry villagers, including a hotel guest, to food close by (spec §7.10). */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { VillagerProfile } from '../../../src/shared/types.ts';
import { ready, SIM_FEATURES, waitingFor } from '../../helpers/features.ts';
import { createTestWorld } from '../../helpers/world.ts';

const FEATURES = [...SIM_FEATURES, 'needs'] as const;
/** Eating, as opposed to food work such as "Baking bread" at the bakery (which barely feeds the baker). */
const FOOD = /\b(eat|lunch|breakfast|dinner|bite|snack|meal|brunch|picnic|coffee|cake|ice cream)/i;
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

describe('eating vs food work', () => {
  it('counts meals and snacks as eating, but not baking bread', () => {
    for (const a of ['Baking bread', 'bake bread and buns', 'Selling bread', 'Taste the dough'])
      expect(FOOD.test(a), a).toBe(false);
    for (const a of [
      'Grab a bite to eat at the bakery',
      'Eat a snack at home',
      'Grab an ice cream snack',
      'Lunch at the cafe',
    ])
      expect(FOOD.test(a), a).toBe(true);
  });
});

describe.skipIf(!ready(...FEATURES))(`hunger override near food${waitingFor(...FEATURES)}`, () => {
  it('every hungry stretch, the first and each one after an override ends, reaches food within 60 minutes, and eating stops the decline', async () => {
    const w = await createTestWorld({
      profiles: [...residents, GUEST],
      villagers: residents.length + 1,
      startAt: '07:00',
      config: { needs: { decayPerHour: { hunger: 45, energy: 4, social: 5, fun: 4 } } },
    });
    /** Start of the current stretch below 20 hunger without eating, per villager. */
    const hungrySince = new Map<string, number>();
    /** Start time and hunger of the current meal, per villager. */
    const meal = new Map<string, { at: number; hunger: number }>();
    const stretches: { id: string; from: number; to: number; repeat: boolean }[] = [];
    const late: { id: string; from: number; to: number | null }[] = [];
    /** Villagers whose hunger kept falling while they ate (eating must restore at least the decay). */
    const starving = new Set<string>();
    let lastTime = 0;
    await w.advanceTo('15:00', {
      chunk: 2,
      onStep: ({ time, snapshot }) => {
        lastTime = time;
        for (const v of snapshot().villagers) {
          if (v.status === 'sleeping') continue;
          const eating = v.status !== 'walking' && FOOD.test(v.activity.text);
          if (!eating) {
            meal.delete(v.id);
            if (v.needs.hunger < 20 && !hungrySince.has(v.id)) hungrySince.set(v.id, time);
            continue;
          }
          const since = hungrySince.get(v.id);
          if (since !== undefined) {
            const repeat = stretches.some((s) => s.id === v.id);
            stretches.push({ id: v.id, from: since, to: time, repeat });
            if (time - since > 60) late.push({ id: v.id, from: since, to: time });
            hungrySince.delete(v.id);
          }
          const m = meal.get(v.id) ?? { at: time, hunger: v.needs.hunger };
          meal.set(v.id, m);
          if (time - m.at <= 20 && v.needs.hunger < m.hunger - 1) starving.add(v.id);
        }
      },
    });
    w.dispose();
    for (const [id, from] of hungrySince)
      if (lastTime - from > 60) late.push({ id, from, to: null });
    expect(stretches.some((s) => s.id === 'guest')).toBe(true);
    // The renewal boundary: hunger stays critical through a meal at this decay, so the villager is
    // hungry again the moment the override block ends.
    expect(stretches.some((s) => s.repeat)).toBe(true);
    expect(late, JSON.stringify(late)).toEqual([]);
    expect([...starving]).toEqual([]);
  }, 180_000);
});
