/** AC5: a proposed event happens with at least 3 attendees. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EventUpdatedMsg } from '../../src/shared/protocol.ts';
import { at, minuteOfDay } from '../../src/shared/time.ts';
import { checkEvents } from '../helpers/checks.ts';
import { ready, SIM_FEATURES, waitingFor } from '../helpers/features.ts';
import { createTestWorld, type TestWorld } from '../helpers/world.ts';

describe.skipIf(!ready(...SIM_FEATURES))(`AC5: village events${waitingFor(...SIM_FEATURES)}`, () => {
  let w: TestWorld;
  let proposedBy11 = 0;

  beforeAll(async () => {
    w = await createTestWorld({ villagers: 10, startAt: '06:00', seed: 3 });
    await w.advanceTo('11:00');
    proposedBy11 = w.state().events.length;
    await w.advanceTo(at(0, '23:30'));
  }, 300_000);

  afterAll(() => w?.dispose());

  it('proposes at least one event by 11:00 (events.ensureDaily)', () => {
    expect(proposedBy11).toBeGreaterThanOrEqual(1);
  });

  it('runs an event to done with >= 3 attendees', () => {
    const result = checkEvents(w.state().events);
    expect(result.detail).toBe(result.pass ? result.detail : 'an event with >= 3 attendees');
    expect(result.pass).toBe(true);
  });

  it('broadcasts the status changes and remembers who attended', () => {
    const done = w.state().events.find((e) => e.status === 'done' && e.attendees.length >= 3)!;
    const statuses = (w.of('event.updated') as EventUpdatedMsg[])
      .filter((m) => m.event.id === done.id)
      .map((m) => m.event.status);
    expect(statuses).toContain('happening');
    expect(statuses).toContain('done');
    const ids = new Set(w.state().villagers.map((v) => v.id));
    for (const a of done.attendees) {
      expect(ids.has(a) || a === 'player', a).toBe(true);
      if (a === 'player') continue;
      expect(
        w.memories(a).some((m) => m.kind === 'event' && m.createdAt >= done.end - 5),
        `${a} remembers ${done.title}`,
      ).toBe(true);
    }
    expect(minuteOfDay(done.start)).toBeLessThan(minuteOfDay(done.end));
  });
});
