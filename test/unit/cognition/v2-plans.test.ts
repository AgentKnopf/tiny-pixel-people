import { describe, expect, it } from 'vitest';
import { at, dayOf, minuteOfDay } from '../../../src/shared/time.ts';
import type { ChatRequest } from '../../../src/server/llm/types.ts';
import type { Notice, PlanBlock, Romance, VillagerProfile } from '../../../src/server/../shared/types.ts';
import { MockChatProvider } from '../../../src/server/llm/providers/mock.ts';
import { sanitizeBlocks, addVisit } from '../../../src/server/cognition/sanitize.ts';
import { locationLines } from '../../../src/server/cognition/prompts/common.ts';
import { wakeWindow, workLocation } from '../../../src/server/cognition/planning.ts';
import { createTestVillage, PROFILES, V2_LOCATIONS } from './helpers.ts';

const ZOO = { open: 8 * 60, close: 21 * 60 };
const mia = PROFILES[0]!;
const ctx = { locations: V2_LOCATIONS, homeId: mia.homeId, window: wakeWindow(mia), zoo: ZOO };
const b = (start: string, end: string, locationId: string, activity = 'do things'): PlanBlock => ({
  start: minuteOfDay(at(0, start)),
  end: minuteOfDay(at(0, end)),
  locationId,
  activity,
});

function person(id: string, name: string, occupation: string): VillagerProfile {
  return {
    id,
    name,
    age: id === 'laude' ? 46 : 31,
    occupation,
    bio: `${name} lives near the post office.`,
    traits: ['shy'],
    homeId: `house_${id}`,
    sprite: `characters/${id}.png`,
    wakeTime: '06:00',
    sleepTime: '22:00',
  };
}
const LAUDE = person('laude', 'Laude', 'Postmaster');
const FRANZI = person('franzi', 'Franzi', 'Illustrator (draws postcards)');
const SHY: Romance = {
  id: 'rom-laude-franzi',
  pair: ['franzi', 'laude'],
  stage: 'crush',
  since: 0,
  crushFrom: ['laude', 'franzi'],
  shy: true,
  dates: [],
  updatedAt: 0,
};

function scriptedPlan(blocks: [string, string, string, string][]) {
  return () => JSON.stringify({ summary: 'my day', blocks });
}

describe('plan sanitizing (v2)', () => {
  it('moves the closed part of a block to the nearest open place and keeps the open part', () => {
    const out = sanitizeBlocks([b('19:00', '22:00', 'rollercoaster', 'ride the rollercoaster')], ctx);
    expect(out.map((x) => [x.start, x.end, x.locationId])).toEqual([
      [19 * 60, 21 * 60, 'rollercoaster'],
      // The forest (open until 22:00) is the closest open alternative to the rides.
      [21 * 60, 22 * 60, 'forest'],
    ]);
    const post = sanitizeBlocks([b('07:00', '09:00', 'post_office')], ctx);
    expect(post[0]).toMatchObject({ start: 420, end: 480 });
    expect(post[0]!.locationId).not.toBe('post_office');
    expect(post[1]).toMatchObject({ start: 480, end: 540, locationId: 'post_office' });
  });

  it('sends forest blocks after 22:00 home, never plans the butcher and leaves events alone', () => {
    const late = sanitizeBlocks([b('21:00', '23:30', 'forest_lake', 'night fishing')], ctx);
    expect(late.map((x) => [x.start, x.end, x.locationId])).toEqual([
      [21 * 60, 22 * 60, 'forest_lake'],
      [22 * 60, 23 * 60 + 30, mia.homeId],
    ]);
    expect(sanitizeBlocks([b('10:00', '11:00', 'butcher')], ctx)[0]!.locationId).not.toBe('butcher');
    const ev = { ...b('20:00', '22:00', 'rollercoaster'), eventId: 'ev1' };
    expect(sanitizeBlocks([ev], ctx)).toEqual([ev]);
  });

  it('keeps a model plan inside opening hours when the villager adopts it', async () => {
    const p = new MockChatProvider();
    p.setScript(
      'plan.day',
      scriptedPlan([
        ['06:00', '07:30', 'zoo_gate', 'early zoo visit'],
        ['07:30', '19:00', 'bakery', 'bake'],
        ['19:00', '22:00', 'rollercoaster', 'ride the rollercoaster'],
      ]),
    );
    const v = createTestVillage({
      start: at(0, '05:00'),
      provider: p,
      profiles: [mia],
      locations: V2_LOCATIONS,
    });
    await v.advanceTo(at(0, '05:10'));
    const plan = v.worlds.get('mia')!.plan!;
    expect(plan.source).toBe('llm');
    for (const blk of plan.blocks) {
      if (blk.locationId === 'rollercoaster' || blk.locationId === 'zoo_gate') {
        expect(blk.start).toBeGreaterThanOrEqual(8 * 60);
        expect(blk.end).toBeLessThanOrEqual(21 * 60);
      }
    }
    expect(plan.blocks.some((x) => x.locationId === 'rollercoaster')).toBe(true);
  });

  it('gives Franzi a 20-40 minute post office visit on most days, within opening hours', async () => {
    const v = createTestVillage({
      start: at(0, '05:00'),
      profiles: [LAUDE, FRANZI],
      locations: V2_LOCATIONS,
      extraView: () => ({ romances: [SHY] }),
    });
    const days = new Set<number>();
    for (let d = 0; d < 7; d++) {
      await v.advanceTo(at(d, '12:00'), 10);
      const plan = v.worlds.get('franzi')!.plan!;
      const visit = plan.blocks.find((x) => x.locationId === 'post_office');
      if (visit) {
        days.add(plan.day);
        expect(visit.end - visit.start).toBeGreaterThanOrEqual(20);
        expect(visit.end - visit.start).toBeLessThanOrEqual(40);
        expect(visit.start).toBeGreaterThanOrEqual(8 * 60);
        expect(visit.end).toBeLessThanOrEqual(18 * 60);
      }
      // Laude works there; he gets no extra "visit".
      expect(v.worlds.get('laude')!.plan!.blocks.some((x) => x.activity === 'drop by the post office')).toBe(
        false,
      );
      await v.advanceTo(at(d + 1, '05:00'), 30);
    }
    expect(days.size).toBeGreaterThanOrEqual(4);
    expect(workLocation(LAUDE, V2_LOCATIONS)).toBe('post_office');
    expect(workLocation(FRANZI, V2_LOCATIONS)).not.toBe('post_office');
  }, 30_000);

  it('adds the visit only once and away from events', () => {
    const ev = { ...b('08:00', '18:00', 'square'), eventId: 'ev1' };
    expect(
      addVisit(
        [ev],
        V2_LOCATIONS.find((l) => l.id === 'post_office')!,
        ctx,
        {
          key: 'k',
          activity: 'visit',
          emoji: '✉️',
        },
      ),
    ).toEqual([ev]);
    const once = addVisit(
      [b('06:00', '22:00', 'post_office')],
      V2_LOCATIONS.find((l) => l.id === 'post_office')!,
      ctx,
      {
        key: 'k',
        activity: 'visit',
        emoji: '✉️',
      },
    );
    expect(once).toHaveLength(1);
  });

  it('lists the new places compactly, with hours, and without the butcher or hotel', () => {
    const text = locationLines(V2_LOCATIONS, mia.homeId);
    expect(text).toContain('post_office (Post Office, open 08:00-18:00)');
    expect(text).toContain('zoo animals to watch: zoo_lion zoo_penguin');
    expect(text).not.toMatch(/butcher|hotel \(|house_ben/);
  });
});

describe('Laude and bake-offs', () => {
  it('invites Laude to a bake-off, and he accepts and plans it', async () => {
    const v = createTestVillage({ start: at(0, '06:55'), profiles: [mia, LAUDE], locations: V2_LOCATIONS });
    await v.advanceTo(at(0, '07:30'));
    const ev = v.events.find((e) => /bake/i.test(e.title))!;
    expect(ev.hostId).toBe('mia');
    expect(ev.invitees).toContain('laude');
    expect(ev.accepted).toContain('laude');
    expect(v.worlds.get('laude')!.plan!.blocks.some((x) => x.eventId === ev.id)).toBe(true);
    expect(
      v.queue.requests.filter((r) => r.task === 'event.decide' && r.meta?.villagerId === 'laude'),
    ).toHaveLength(0);
  });

  it('joins a bake-off he was not invited to, unless a date of his overlaps it', async () => {
    const v = createTestVillage({ start: at(0, '08:00'), profiles: [mia, LAUDE], locations: V2_LOCATIONS });
    const base = {
      description: 'Bring your best bread',
      hostId: 'mia',
      locationId: 'square',
      invitees: [],
      accepted: [],
      declined: [],
      attendees: [],
      status: 'scheduled' as const,
    };
    v.events.push({ ...base, id: 'ev-bake', title: 'Bake-off', start: at(0, '15:00'), end: at(0, '17:00') });
    v.events.push({
      ...base,
      id: 'ev-bake2',
      title: 'Baking contest',
      start: at(1, '15:00'),
      end: at(1, '17:00'),
    });
    v.events.push({
      ...base,
      id: 'ev-date',
      title: 'Date',
      kind: 'date',
      hostId: 'laude',
      invitees: ['franzi'],
      start: at(1, '16:00'),
      end: at(1, '17:30'),
    });
    await v.advanceTo(at(0, '08:05'));
    expect(v.events.find((e) => e.id === 'ev-bake')!.accepted).toContain('laude');
    const second = v.events.find((e) => e.id === 'ev-bake2')!;
    expect(second.accepted).not.toContain('laude');
    expect(second.declined).toContain('laude');
  });
});

describe('notices, forest and visitors', () => {
  it('reads each notice in reach once, with the notice origin', async () => {
    const notices: Notice[] = [
      {
        id: 'n1',
        authorId: 'player',
        text: 'Lost cat, answers to Biscuit',
        postedAt: 0,
        expiresAt: at(3, '00:00'),
        originId: 'mem-laude-1',
      },
      {
        id: 'n2',
        authorId: 'mia',
        text: '📌 Bake-off at Square, 15:00. All welcome! (Mia)',
        postedAt: 0,
        expiresAt: at(3, '00:00'),
      },
    ];
    const v = createTestVillage({
      start: at(0, '08:00'),
      profiles: [mia],
      locations: V2_LOCATIONS,
      extraView: () => ({ noticesInReach: notices }),
    });
    await v.advanceTo(at(0, '08:30'));
    const read = v.minds
      .get('mia')!
      .memory.all()
      .filter((m) => m.meta.noticeId);
    expect(read.map((m) => [m.meta.noticeId, m.meta.originId, m.importance])).toEqual([
      ['n1', 'mem-laude-1', 5],
      ['n2', 'n2', 4],
    ]);
    expect(read[0]!.text).toBe('The notice board says: Lost cat, answers to Biscuit');
  });

  it('notes one forest animal per visit, without an importance.rate call', async () => {
    const v = createTestVillage({
      start: at(0, '08:00'),
      profiles: [mia],
      locations: V2_LOCATIONS,
      extraView: () => ({ animalsNearby: [{ id: 'deer_1', species: 'deer', distance: 3 }] }),
    });
    const s = v.states.get('mia')!;
    const mind = v.minds.get('mia')!;
    const sightings = () => mind.memory.all().filter((m) => /I saw a deer/.test(m.text));
    s.locationId = 'forest_lake';
    for (let i = 0; i < 5; i++) mind.update(v.view('mia'));
    expect(sightings()).toHaveLength(1);
    expect(sightings()[0]).toMatchObject({ text: 'I saw a deer near the lake.', importance: 2 });
    s.locationId = 'square';
    mind.update(v.view('mia'));
    s.locationId = 'forest';
    mind.update(v.view('mia'));
    expect(sightings()).toHaveLength(2);
    await v.queue.drain();
    expect(v.queue.count('importance.rate')).toBe(0);
  });

  it("ends a visitor's leaving day at the station 30 minutes before the train", async () => {
    const guest: VillagerProfile = {
      ...person('vis1', 'Ada', 'Traveller'),
      homeId: 'hotel',
      transient: true,
      visitor: true,
    };
    const departsAt = at(1, '16:00');
    const v = createTestVillage({
      start: at(1, '05:00'),
      profiles: [guest],
      locations: V2_LOCATIONS,
      extraView: () => ({
        visitor: {
          villagerId: 'vis1',
          arrivedAt: at(0, '10:00'),
          departsAt,
          roomId: 'hotel_room_1',
          origin: 'the city',
          status: 'checkedIn',
          source: 'llm',
        },
      }),
    });
    await v.advanceTo(at(1, '06:10'));
    const plan = v.worlds.get('vis1')!.plan!;
    const last = plan.blocks.at(-1)!;
    expect(last).toMatchObject({ locationId: 'station', end: 15 * 60 + 30 });
    const prompt = v.queue.requests.find((r: ChatRequest) => r.task === 'plan.day')!;
    expect(prompt.messages.map((m) => m.content).join('\n')).toContain('be at the station by 15:30');
    await v.advanceTo(at(1, '15:45'), 15);
    expect(v.states.get('vis1')!.locationId).toBe('station');
    expect(dayOf(departsAt)).toBe(1);
  });
});
