/** §14.1 World events (toolbar): rain, party, stranger, birthday, town event. */
import { afterEach, describe, expect, it } from 'vitest';
import type { VillagersChangedMsg, WeatherUpdatedMsg, WorldEventMsg } from '../../src/shared/protocol.ts';
import { PLAYER_ID } from '../../src/shared/types.ts';
import { at, minuteOfDay } from '../../src/shared/time.ts';
import { ready, SIM_FEATURES, waitingFor } from '../helpers/features.ts';
import { awake, createTestWorld, currentBlock, type TestWorld } from '../helpers/world.ts';

const FEATURES = [...SIM_FEATURES, 'player', 'worldEvents'] as const;
let w: TestWorld | undefined;
afterEach(() => w?.dispose());

describe.skipIf(!ready(...FEATURES))(`§14.1 world events${waitingFor(...FEATURES)}`, () => {
  it('rain: weather changes, outdoor blocks move indoors, then it ends', async () => {
    w = await createTestWorld({ startAt: '06:00' });
    await w.advanceTo('10:00');
    w.command({ type: 'world.trigger', kind: 'rain' });
    await w.advance(10);
    const s = w.state();
    expect(s.weather.state).toBe('rain');
    expect(w.of('weather.updated').length).toBeGreaterThanOrEqual(1);
    expect((w.of('world.event') as WorldEventMsg[]).some((m) => m.event.kind === 'rain')).toBe(true);
    for (const v of s.villagers.filter(awake)) {
      const block = currentBlock(v, s.time);
      if (!block || block.eventId) continue;
      const kind = w.location(block.locationId)?.kind;
      expect(kind === 'public' || kind === 'nature', `${v.id} block at ${block.locationId} during rain`).toBe(
        false,
      );
    }
    expect(s.villagers.some((v) => w!.memories(v.id).some((m) => /rain/i.test(m.text)))).toBe(true);
    await w.advance(3 * 60 + 10);
    expect(w.state().weather.state).toBe('clear');
    const updates = w.of('weather.updated') as WeatherUpdatedMsg[];
    expect(updates.at(-1)!.weather.state).toBe('clear');
  }, 120_000);

  it('party: creates a VillageEvent hosted by the player, starting in 30 minutes', async () => {
    w = await createTestWorld({ startAt: '06:00' });
    await w.advanceTo('10:00');
    const t = w.now();
    const awakeCount = w.state().villagers.filter(awake).length;
    w.command({ type: 'world.trigger', kind: 'party' });
    await w.advance(1);
    const party = w.state().events.find((e) => e.hostId === PLAYER_ID && /party/i.test(e.title));
    expect(party).toBeDefined();
    expect(party!.start - t).toBeGreaterThanOrEqual(25);
    expect(party!.start - t).toBeLessThanOrEqual(35);
    expect(party!.end - party!.start).toBe(120);
    expect(party!.invitees.length).toBeGreaterThanOrEqual(awakeCount);
    await w.advanceTo(party!.end + 5);
    const after = w.state().events.find((e) => e.id === party!.id)!;
    expect(after.accepted.length).toBeGreaterThan(0);
    expect(after.status).toBe('done');
    expect(after.attendees.length).toBeGreaterThanOrEqual(3);
  }, 120_000);

  it.skipIf(!ready(...FEATURES, 'strangers'))(
    'stranger: arrives with a mind and leaves at the end of the day',
    async () => {
      w = await createTestWorld({ startAt: '06:00' });
      await w.advanceTo('09:00');
      // Residents and strangers only: v2 train visitors come and go on their own schedule.
      const settled = () => w!.state().villagers.filter((v) => !w!.profile(v.id).visitor);
      const before = settled().length;
      w.command({ type: 'world.trigger', kind: 'stranger' });
      await w.advance(5);
      const added = (w.of('villagers.changed') as VillagersChangedMsg[]).flatMap((m) => m.added);
      expect(added).toHaveLength(1);
      const stranger = added[0]!;
      expect(stranger.transient).toBe(true);
      expect(settled()).toHaveLength(before + 1);
      await w.advance(60);
      expect(w.memories(stranger.id).length).toBeGreaterThan(0);
      expect(w.inspect(stranger.id)?.villagerId).toBe(stranger.id);
      await w.advanceTo(at(1, '02:00'));
      const removed = (w.of('villagers.changed') as VillagersChangedMsg[]).flatMap((m) => m.removed);
      expect(removed).toContain(stranger.id);
      expect(settled()).toHaveLength(before);
    },
    180_000,
  );

  it('birthday: everyone remembers it and there is a party at 17:00', async () => {
    w = await createTestWorld({ startAt: '06:00' });
    await w.advanceTo('09:00');
    const v = w.state().villagers[0]!;
    const name = w.profile(v.id).name;
    w.command({ type: 'world.trigger', kind: 'birthday', villagerId: v.id });
    await w.advance(2);
    for (const other of w.state().villagers)
      expect(
        w.memories(other.id).some((m) => m.text.includes(name) && /birthday/i.test(m.text)),
        `${other.id} knows about ${name}'s birthday`,
      ).toBe(true);
    const ev = w.state().events.find((e) => /birthday/i.test(e.title) && e.title.includes(name));
    expect(ev).toBeDefined();
    expect(minuteOfDay(ev!.start)).toBe(17 * 60);
  }, 120_000);

  it('town event: asks a villager to propose an event now', async () => {
    w = await createTestWorld({ startAt: '06:00', config: { events: { ensureDaily: false } } });
    await w.advanceTo('09:00');
    const calls = w.provider.callCount('event.propose');
    const events = w.state().events.length;
    w.command({ type: 'world.trigger', kind: 'townEvent' });
    await w.advance(5);
    expect(w.provider.callCount('event.propose')).toBeGreaterThan(calls);
    expect(w.state().events.length).toBeGreaterThan(events);
  }, 120_000);
});
