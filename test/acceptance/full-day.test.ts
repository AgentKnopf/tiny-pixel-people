/**
 * AC2 (10 villagers, full day, plans followed) and AC6 (inspector data) on the virtual clock with
 * the mock provider. Spec §14.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InspectDataMsg } from '../../src/shared/protocol.ts';
import type { WorldSnapshot } from '../../src/shared/types.ts';
import { at, dayOf } from '../../src/shared/time.ts';
import { checkInspector, checkPlans, planAdherence, type AdherenceSample } from '../helpers/checks.ts';
import { ready, SIM_FEATURES, waitingFor } from '../helpers/features.ts';
import { createTestWorld, type TestWorld } from '../helpers/world.ts';

describe.skipIf(!ready(...SIM_FEATURES))(`AC2 + AC6: a full game day${waitingFor(...SIM_FEATURES)}`, () => {
  let w: TestWorld;
  const samples: AdherenceSample[] = [];
  const activities = new Map<string, Set<string>>();
  let midday: WorldSnapshot;
  const inspected: { id: string; msg: InspectDataMsg | undefined }[] = [];

  beforeAll(async () => {
    w = await createTestWorld({ villagers: 10, startAt: '06:00' });
    const onStep = ({ time, snapshot }: { time: number; snapshot: () => WorldSnapshot }) => {
      const s = snapshot();
      samples.push({ time, villagers: structuredClone(s.villagers) });
      for (const v of s.villagers) {
        const set = activities.get(v.id) ?? new Set<string>();
        set.add(v.activity.text);
        activities.set(v.id, set);
      }
    };
    await w.advanceTo('12:00', { onStep });
    midday = w.state();
    for (const v of midday.villagers) inspected.push({ id: v.id, msg: w.inspect(v.id) });
    await w.advanceTo(at(1, '06:00'), { onStep });
    await w.advanceTo(at(1, '08:00'));
  }, 300_000);

  afterAll(() => w?.dispose());

  it('runs 10 villagers through a whole day without errors', () => {
    expect(w.now()).toBe(at(1, '08:00'));
    expect(dayOf(w.now())).toBe(1);
    // Residents only: v2 train visitors come and go and are covered by the v2 suites.
    expect(w.state().villagers.filter((v) => !w.profile(v.id).visitor)).toHaveLength(10);
    expect(w.errors()).toEqual([]);
    expect(w.ticks).toBeGreaterThan(0);
  });

  it('gives every villager an LLM plan and they follow it (>= 70 % of awake minutes)', () => {
    const adherence = planAdherence(samples, w.engine.map.locations);
    const result = checkPlans(midday, adherence);
    expect(result.detail).toBe(result.pass ? result.detail : 'all villagers follow their plan');
    expect(result.pass).toBe(true);
  });

  it('shows visible, changing activities for every villager', () => {
    for (const v of midday.villagers) {
      expect(v.activity.text, v.id).not.toBe('');
      expect(activities.get(v.id)?.size ?? 0, `${v.id} activities`).toBeGreaterThanOrEqual(3);
    }
  });

  it('makes a new plan for the next day', () => {
    for (const v of w.state().villagers) {
      expect(v.plan?.day, v.id).toBe(1);
      expect(v.plan?.source, v.id).toBe('llm');
    }
  });

  it('AC6: inspect returns plan + last 10 memories for every villager', () => {
    const result = checkInspector(inspected);
    expect(result.detail).toBe(result.pass ? result.detail : 'inspector ok');
    expect(result.pass).toBe(true);
  });

  it('calls the LLM for plans, conversations and importance', () => {
    expect(w.provider.callCount('plan.day')).toBeGreaterThanOrEqual(10);
    expect(w.provider.callCount('convo.turn')).toBeGreaterThan(0);
    expect(w.provider.callCount('convo.summarize')).toBeGreaterThan(0);
  });
});
