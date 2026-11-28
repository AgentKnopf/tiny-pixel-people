/** TASK-18 I5: the rumour influence handler on the player world (spec §4.1, AC5, AC4 409/422). */
import { describe, expect, it } from 'vitest';
import { InfluenceService } from '../../../src/server/sim/influence.ts';
import type { PlayerWorldSave } from '../../../src/server/player/index.ts';
import type { InfluenceSaveData } from '../../../src/server/persistence/types.ts';
import type { InfluenceRequest, RumourOutcomes, RumourSource } from '../../../src/shared/influence.ts';
import { at } from '../../../src/shared/time.ts';
import { PLAYER_ID } from '../../../src/shared/types.ts';
import { profile, setup, villager } from './fake-host.ts';

const TEXT = 'The bakery will sell cherry pie tomorrow.';
const rumour = (to: string, source: RumourSource = 'passerby', text = TEXT): InfluenceRequest => ({
  endpoint: 'rumour',
  body: { to, text, source },
});

function world(restore?: { pw: Partial<PlayerWorldSave>; influence: InfluenceSaveData; time: number }) {
  const { host, pw } = setup(restore ? { restore: restore.pw } : {});
  host.add(profile('laude', 'Laude', 'house_ben'), villager('laude', { x: 18, y: 11 }));
  host.time = restore?.time ?? at(0, '08:00');
  const town: string[] = [];
  const service = new InfluenceService({
    config: { perGameDay: 6, logMax: 500 },
    now: () => host.time,
    busy: () => false,
    townLog: (text) => {
      town.push(text);
      return new Date(0).toISOString();
    },
    emit: () => {},
    ...(restore ? { restore: restore.influence } : {}),
  });
  pw.registerInfluence(service);
  return { host, pw, service, town };
}

const outcomes = (service: InfluenceService, i = 0) => service.log({}).entries[i]!.outcomes as RumourOutcomes;

describe('rumour influence', () => {
  it('gives the target a heard memory from the source label, importance 7, and tracks the rumour', () => {
    const { host, pw, service, town } = world();
    const res = service.apply(rumour('ada', 'crow'));
    expect(res).toMatchObject({ ok: true, id: 'inf_1', tick: at(0, '08:00') });
    const originId = res.ok ? res.refs.originId : undefined;
    expect(originId).toMatch(/^fact_\d+$/);

    const [memory] = host.memoriesOf('ada');
    expect(memory).toMatchObject({
      kind: 'heard',
      text: `The crow told me: ${TEXT}`,
      importance: 7,
      meta: { originId, influenceId: 'inf_1' },
    });
    expect(memory!.meta).not.toHaveProperty('heardFrom');

    expect(pw.rumors.byOrigin(originId!)).toMatchObject({
      text: TEXT,
      startedBy: PLAYER_ID,
      knownBy: ['ada'],
      hops: [],
    });
    expect(service.log({}).entries[0]).toMatchObject({
      endpoint: 'rumour',
      targets: ['ada'],
      refs: { originId },
      outcomes: { spreadTo: [] },
    });
    expect(service.log({}).entries[0]).not.toHaveProperty('visitor');
    expect(town).toEqual([`The crow told Ada a rumour: ${TEXT} [influence]`]);
    // The player did not walk anywhere or say anything.
    expect(host.of('conversation.message')).toEqual([]);
    expect(pw.state.path).toEqual([]);
  });

  it('every source label is what villagers hear', () => {
    const labels: Record<RumourSource, string> = {
      passerby: 'A passerby',
      traveller: 'A traveller from the train',
      crow: 'The crow',
      child: 'A child in the square',
    };
    for (const [source, label] of Object.entries(labels)) {
      const { host, service } = world();
      expect(service.apply(rumour('ben', source as RumourSource)).ok).toBe(true);
      expect(host.memoriesOf('ben')[0]!.text).toBe(`${label} told me: ${TEXT}`);
    }
  });

  it('a sleeping target is 409 asleep with the next wake time, and nothing changes', () => {
    const { host, pw, service } = world();
    // dot's status is sleeping although 08:00 is inside her 06:00-22:00 window.
    expect(service.apply(rumour('dot'))).toEqual({
      ok: false,
      status: 409,
      error: 'asleep',
      wakesAt: at(0, '08:00') + 1,
    });
    // Ada is not marked sleeping, but 23:00 is outside her window: she wakes at 06:00 tomorrow.
    host.time = at(0, '23:00');
    expect(service.apply(rumour('ada'))).toEqual({
      ok: false,
      status: 409,
      error: 'asleep',
      wakesAt: at(1, '06:00'),
    });
    host.time = at(1, '03:00');
    expect(service.apply(rumour('ada'))).toEqual({
      ok: false,
      status: 409,
      error: 'asleep',
      wakesAt: at(1, '06:00'),
    });
    expect(host.memories).toEqual([]);
    expect(pw.rumors.all()).toEqual([]);
    expect(service.budget().usedToday).toBe(0);
    expect(service.log({}).entries).toEqual([]);
  });

  it('an unknown target is 422 on "to"', () => {
    const { host, service } = world();
    expect(service.apply(rumour('nobody'))).toMatchObject({
      ok: false,
      status: 422,
      error: 'invalid',
      field: 'to',
    });
    expect(service.apply(rumour(PLAYER_ID))).toMatchObject({ ok: false, status: 422, field: 'to' });
    expect(host.memories).toEqual([]);
    expect(service.budget().usedToday).toBe(0);
  });

  it('a visitor in town is a valid target and the log marks it', () => {
    const { host, service } = world();
    host.add(profile('vic', 'Vic', 'hotel', { transient: true }), villager('vic', { x: 14, y: 10 }));
    expect(service.apply(rumour('vic')).ok).toBe(true);
    expect(service.log({}).entries[0]).toMatchObject({ targets: ['vic'], visitor: true });
  });

  it('the Keep and Laude name the source label, never the player', () => {
    const { host, pw, service } = world();
    const res = service.apply(rumour('ada', 'traveller'));
    const originId = res.ok ? res.refs.originId! : '';
    const [entry] = pw.post.keep.all();
    expect(entry).toMatchObject({
      kind: 'rumor',
      text: `Rumor started by A traveller from the train: ${TEXT}`,
    });
    pw.onLearned({ originId, from: 'ada', to: 'ben', at: host.time + 5, text: TEXT });
    expect(pw.post.keep.all()[1]!.text).toBe(`Ada told Ben the rumor: ${TEXT}`);
    const laude = host.memoriesOf('laude');
    expect(laude.map((m) => m.text)).toEqual([
      `📒 Rumor started by A traveller from the train: ${TEXT}`,
      `📒 Ada told Ben the rumor: ${TEXT}`,
    ]);
    const leaks = [...host.memories.map((m) => m.text), ...pw.post.keep.all().map((e) => e.text)].filter(
      (t) => t.includes(pw.state.name) || t.includes('You'),
    );
    expect(leaks).toEqual([]);
  });

  it('the player still signs their own whispered rumours in the Keep', () => {
    const { pw } = world();
    expect(pw.handleCommand({ type: 'player.rumor', villagerId: 'ada', text: TEXT })).toEqual([]);
    expect(pw.post.keep.all()[0]!.text).toBe(`Rumor started by ${pw.state.name}: ${TEXT}`);
  });

  it('spreadTo records each new hop of this rumour once, with its tick', () => {
    const { host, pw, service } = world();
    const res = service.apply(rumour('ada'));
    const originId = res.ok ? res.refs.originId! : '';
    const t = host.time;
    pw.onLearned({ originId, from: 'ada', to: 'ben', at: t + 10, text: TEXT });
    pw.onLearned({ originId, from: 'ada', to: 'ben', at: t + 20, text: TEXT });
    pw.onLearned({ originId: 'fact_other', from: 'ada', to: 'cy', at: t + 25, text: 'Other news.' });
    pw.onLearned({ originId, from: 'ben', to: 'cy', at: t + 30, text: TEXT });
    expect(outcomes(service).spreadTo).toEqual([
      { from: 'ada', to: 'ben', tick: t + 10 },
      { from: 'ben', to: 'cy', tick: t + 30 },
    ]);
  });

  it('two rumours keep their own spreadTo', () => {
    const { host, pw, service } = world();
    const a = service.apply(rumour('ada'));
    const b = service.apply(rumour('ben', 'child', 'Cy found a gold coin.'));
    const [oa, ob] = [a, b].map((r) => (r.ok ? r.refs.originId! : ''));
    expect(oa).not.toBe(ob);
    pw.onLearned({ originId: ob!, from: 'ben', to: 'cy', at: host.time + 3, text: 'Cy found a gold coin.' });
    expect(outcomes(service, 0).spreadTo).toEqual([]);
    expect(outcomes(service, 1).spreadTo).toEqual([{ from: 'ben', to: 'cy', tick: host.time + 3 }]);
  });

  it('after a restore, hops still land on the saved entry', () => {
    const a = world();
    const res = a.service.apply(rumour('ada'));
    const originId = res.ok ? res.refs.originId! : '';
    a.pw.onLearned({ originId, from: 'ada', to: 'ben', at: a.host.time + 5, text: TEXT });
    const saved = {
      pw: structuredClone(a.pw.serialize()),
      influence: structuredClone(a.service.serialize()),
      time: a.host.time + 10,
    };
    const b = world(saved);
    b.pw.onLearned({ originId, from: 'ben', to: 'cy', at: b.host.time, text: TEXT });
    expect(outcomes(b.service).spreadTo).toEqual([
      { from: 'ada', to: 'ben', tick: a.host.time + 5 },
      { from: 'ben', to: 'cy', tick: b.host.time },
    ]);
    // A new rumour after the restore gets a fresh origin id.
    const next = b.service.apply(rumour('cy'));
    expect(next.ok && next.refs.originId).not.toBe(originId);
  });
});
