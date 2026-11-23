/** Cheap cold steps (spec v2 §16): cognition work that runs inside a sim step avoids one-off setup costs. */
import { describe, expect, it } from 'vitest';
import type { Location, VillagerProfile } from '../../../src/shared/types.ts';
import type { LlmQueue } from '../../../src/server/llm/types.ts';
import { workLocation } from '../../../src/server/cognition/planning.ts';
import { compareIds } from '../../../src/server/cognition/rng.ts';
import { Village } from '../../../src/server/cognition/village.ts';

const profile = (id: string, occupation: string, bio = ''): VillagerProfile =>
  ({ id, name: id, occupation, bio, traits: [], homeId: `house_${id}` }) as unknown as VillagerProfile;

describe('cold-step helpers', () => {
  it('orders ids by code unit, like a plain sort', () => {
    const ids = ['tom', 'mia_perf0', 'arthur', 'mia', 'ben'];
    expect([...ids].sort(compareIds)).toEqual([...ids].sort());
  });

  it('bestHost is recomputed when a mind registers', () => {
    const v = new Village({} as LlmQueue);
    v.register({ id: 'ben', profile: profile('ben', 'fisher') });
    expect(v.bestHost()).toBe('ben');
    v.register({ id: 'anna', profile: profile('anna', 'baker', 'loves parties and music') });
    expect(v.bestHost()).toBe('anna');
  });

  it('workLocation answers the same for the same profile and map', () => {
    const locations = [
      { id: 'harbor', name: 'Harbor', kind: 'public', description: 'boats and fishing nets' },
      { id: 'square', name: 'Square', kind: 'public' },
    ] as unknown as Location[];
    const p = profile('ben', 'net mender', 'mends fishing nets');
    expect(workLocation(p, locations)).toBe('harbor');
    expect(workLocation(p, locations)).toBe('harbor');
    expect(workLocation(profile('ben', 'net mender', 'mends fishing nets'), locations)).toBe('harbor');
  });
});
