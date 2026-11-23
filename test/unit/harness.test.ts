/** Self-test of the headless harness and the shared acceptance checks against a fake engine. */
import { describe, expect, it } from 'vitest';
import type { ConversationMessageMsg } from '../../src/shared/protocol.ts';
import type { VillageEvent, VillagerState } from '../../src/shared/types.ts';
import { at } from '../../src/shared/time.ts';
import {
  checkEvents,
  checkGossip,
  checkInspector,
  checkNote,
  checkPlans,
  formatReport,
  isFollowing,
  planAdherence,
  replyOverlap,
  type AdherenceSample,
} from '../helpers/checks.ts';
import { createFakeEngine } from '../helpers/fake-engine.ts';
import { createTestWorld, testConfig } from '../helpers/world.ts';

describe('test harness', () => {
  it('builds an isolated mock config', () => {
    const cfg = testConfig({ villagers: 4, config: { sim: { seed: 9 } } });
    expect(cfg.llm.provider).toBe('mock');
    expect(cfg.embeddings.provider).toBe('mock');
    expect(cfg.sim).toMatchObject({ villagers: 4, seed: 9 });
    expect(cfg.debug).toBe(true);
    expect(cfg.persistence.loadOnStart).toBe(false);
    expect(testConfig({ embeddings: false }).embeddings.provider).toBe('none');
  });

  it('drives a day, samples it and judges AC2/AC4/AC6 with the shared checks', async () => {
    const w = await createTestWorld({ engineFactory: createFakeEngine, startAt: '06:00' });
    const samples: AdherenceSample[] = [];
    await w.advanceTo('08:00', {
      onStep: ({ time, snapshot }) => samples.push({ time, villagers: snapshot().villagers }),
    });
    expect(w.now()).toBe(at(0, '08:00'));
    expect(w.ticks).toBe(120);
    w.command({ type: 'note.post', houseId: 'house_0', text: 'Please feed the ducks in the pond' });
    expect(w.of('note.updated')).toHaveLength(1);
    const reachedSquare = await w.until((x) => x.villager('v0').locationId === 'square', 120);
    expect(reachedSquare).toBe(true);
    expect(w.now()).toBe(at(0, '09:01'));
    await w.advanceTo('20:00', {
      onStep: ({ time, snapshot }) => samples.push({ time, villagers: snapshot().villagers }),
    });
    const inspected = w.state().villagers.map((v) => ({ id: v.id, msg: w.inspect(v.id) }));
    expect(checkInspector(inspected).pass).toBe(true);
    const adherence = planAdherence(samples, w.engine.map.locations);
    expect(adherence.every((a) => a.ratio === 1)).toBe(true);
    expect(checkPlans(w.state(), adherence).pass).toBe(true);
    const note = w.state().notes[0];
    expect(note?.readAt).toBe(at(0, '17:01'));
    expect(checkNote(note).pass).toBe(true);
    // advanceTo goes to the next occurrence of a clock time
    await w.advanceTo('07:00');
    expect(w.now()).toBe(at(1, '07:00'));
    expect(w.errors()).toEqual([]);
    expect(w.command({ type: 'save' })[0]?.type).toBe('error');
    w.dispose();
  });
});

const villager = (over: Partial<VillagerState>): VillagerState => ({
  id: 'a',
  pos: { x: 0, y: 0 },
  facing: 'down',
  path: [],
  locationId: null,
  status: 'acting',
  activity: { text: 'x', emoji: '', locationId: null, since: 0 },
  thought: '',
  needs: { hunger: 50, energy: 50, social: 50, fun: 50 },
  relationships: {},
  plan: {
    day: 0,
    summary: '',
    revision: 0,
    source: 'llm',
    createdAt: 0,
    blocks: [{ start: 600, end: 700, locationId: 'square', activity: 'x' }],
  },
  ...over,
});
const LOCS = [
  {
    id: 'square',
    name: 'Square',
    kind: 'public' as const,
    area: { x: 10, y: 10, w: 4, h: 4 },
    entry: { x: 12, y: 14 },
  },
];

describe('acceptance checks', () => {
  it('isFollowing: at location, en route, off plan, excused', () => {
    expect(isFollowing(villager({ locationId: 'square' }), 650, LOCS)).toBe(true);
    expect(isFollowing(villager({ status: 'walking', path: [{ x: 12, y: 14 }] }), 650, LOCS)).toBe(true);
    expect(isFollowing(villager({ status: 'walking', path: [{ x: 1, y: 1 }] }), 650, LOCS)).toBe(false);
    expect(isFollowing(villager({ locationId: 'cafe' }), 650, LOCS)).toBe(false);
    expect(isFollowing(villager({ pos: { x: 11, y: 11 } }), 650, LOCS)).toBe(true);
    expect(isFollowing(villager({ status: 'talking' }), 650, LOCS)).toBeNull();
    expect(isFollowing(villager({ status: 'sleeping' }), 650, LOCS)).toBeNull();
    expect(isFollowing(villager({}), 800, LOCS)).toBeNull();
  });

  it('checkPlans fails on fallback plans and low adherence', () => {
    const snap = { villagers: [villager({ plan: { ...villager({}).plan!, source: 'fallback' } })] } as never;
    expect(checkPlans(snap, []).pass).toBe(false);
    const samples = [600, 610, 620, 630].map((t, i) => ({
      time: t,
      villagers: [villager({ locationId: i ? 'cafe' : 'square' })],
    }));
    const adh = planAdherence(samples, LOCS);
    expect(adh[0]).toMatchObject({ samples: 4, following: 1, ratio: 0.25 });
    expect(checkPlans({ villagers: [villager({})] } as never, adh).detail).toContain('adherence 25%');
  });

  it('checkGossip ignores the source and messages outside the window', () => {
    const m = (speakerId: string, text: string, time: number): ConversationMessageMsg => ({
      type: 'conversation.message',
      conversationId: 'c',
      speakerId,
      listenerId: 'x',
      text,
      time,
    });
    expect(checkGossip([m('a', 'Biscuit!', 500)], 'biscuit', 'a', 480, 1200).pass).toBe(false);
    expect(checkGossip([m('b', 'Biscuit!', 1300)], 'biscuit', 'a', 480, 1200).pass).toBe(false);
    expect(
      checkGossip([m('b', 'Did you hear about biscuit?', 900)], 'Biscuit', 'a', 480, 1200),
    ).toMatchObject({ pass: true });
  });

  it('replyOverlap / checkNote need real content overlap', () => {
    expect(replyOverlap('Water the sunflowers', 'I will water your sunflowers!').shared).toEqual([
      'water',
      'sunflowers',
    ]);
    const note = {
      id: 'n',
      houseId: 'h',
      ownerId: 'a',
      authorId: 'player',
      text: 'Water the sunflowers',
      postedAt: 0,
      status: 'replied' as const,
    };
    expect(checkNote({ ...note, reply: 'Thanks!' }).pass).toBe(false);
    expect(checkNote({ ...note, status: 'read' }).pass).toBe(false);
    expect(checkNote(undefined).pass).toBe(false);
  });

  it('checkEvents counts distinct attendees of done events', () => {
    const ev = (status: VillageEvent['status'], attendees: string[]): VillageEvent => ({
      id: 'e',
      title: 'Bake-off',
      description: '',
      hostId: 'a',
      locationId: 'square',
      start: 900,
      end: 1020,
      invitees: [],
      accepted: [],
      declined: [],
      attendees,
      status,
    });
    expect(checkEvents([ev('done', ['a', 'a', 'b'])]).pass).toBe(false);
    expect(checkEvents([ev('happening', ['a', 'b', 'c'])]).pass).toBe(false);
    expect(checkEvents([ev('done', ['a', 'b', 'c'])]).pass).toBe(true);
  });

  it('checkInspector flags missing plans, too many memories and embeddings', () => {
    expect(checkInspector([{ id: 'a', msg: undefined }]).pass).toBe(false);
    const mem = (i: number) => ({
      id: `m${i}`,
      villagerId: 'a',
      createdAt: 100 - i,
      lastAccessedAt: 0,
      kind: 'observation' as const,
      text: '',
      importance: 1,
      keywords: [],
      meta: {},
    });
    const msg = {
      type: 'inspect.data' as const,
      villagerId: 'a',
      state: villager({}),
      plan: villager({}).plan,
      relationships: {},
      memories: Array.from({ length: 11 }, (_, i) => mem(i)),
    };
    expect(checkInspector([{ id: 'a', msg }]).detail).toContain('max 10');
    expect(
      checkInspector([{ id: 'a', msg: { ...msg, memories: [{ ...mem(0), embedding: [1] } as never] } }])
        .detail,
    ).toContain('embeddings');
    expect(formatReport([{ id: 'AC6', title: 't', pass: true, detail: 'd' }])).toContain('1/1 checks passed');
  });
});
