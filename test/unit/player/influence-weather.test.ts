/** TASK-18 I3: the weather influence handler on the player world (spec §4.5, AC9, AC4 409s). */
import { describe, expect, it } from 'vitest';
import { InfluenceService } from '../../../src/server/sim/influence.ts';
import type { PlayerWorldSave } from '../../../src/server/player/index.ts';
import type { InfluenceRequest, WeatherOutcomes } from '../../../src/shared/influence.ts';
import type { DayPlan } from '../../../src/shared/types.ts';
import type { InfluenceSaveData } from '../../../src/server/persistence/types.ts';
import { advance, setup, type FakeHost } from './fake-host.ts';

const rain = (hours: number): InfluenceRequest => ({ endpoint: 'weather', body: { weather: 'rain', hours } });
const clear: InfluenceRequest = { endpoint: 'weather', body: { weather: 'clear' } };

function plan(): DayPlan {
  return {
    day: 0,
    summary: '',
    revision: 1,
    source: 'llm',
    createdAt: 0,
    blocks: [
      { start: 360, end: 470, locationId: 'park', activity: 'morning walk', done: true },
      { start: 480, end: 600, locationId: 'park', activity: 'picnic' },
      { start: 600, end: 700, locationId: 'square', activity: 'chat', eventId: 'ev' },
      { start: 700, end: 800, locationId: 'square', activity: 'people watching' },
      { start: 800, end: 900, locationId: 'bakery', activity: 'buy bread' },
    ],
  };
}

function world(restore?: { pw: Partial<PlayerWorldSave>; influence: InfluenceSaveData; time: number }) {
  const { host, pw } = setup(restore ? { restore: restore.pw } : {});
  host.time = restore?.time ?? 8 * 60;
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

const blocksOf = (host: FakeHost, id: string) =>
  host.states.find((v) => v.id === id)!.plan!.blocks.map((b) => b.locationId);
const outcomes = (service: InfluenceService, i: number) =>
  service.log({}).entries[i]!.outcomes as WeatherOutcomes;

describe('weather influence', () => {
  it('rain for 2 hours: until = now + 120, outdoor blocks move indoors, logged honestly (AC9)', () => {
    const { host, pw, service, town } = world();
    host.states.find((v) => v.id === 'ada')!.plan = plan();
    const res = service.apply(rain(2));
    expect(res).toMatchObject({ ok: true, id: 'inf_1', tick: 480 });
    expect(pw.weather).toMatchObject({ state: 'rain', since: 480, until: 480 + 120 });
    const rainEvent = pw.events.active().find((e) => e.kind === 'rain')!;
    expect(res.ok && res.refs).toEqual({ worldEventId: rainEvent.id });
    const locs = blocksOf(host, 'ada');
    expect(locs[0]).toBe('park');
    expect(locs[1]).not.toBe('park');
    expect(locs[2]).toBe('square');
    expect(locs[3]).not.toBe('square');
    expect(outcomes(service, 0)).toEqual({ startedAt: 480, swaps: 2 });
    expect(town).toEqual(['It started raining for 2 hours [influence]']);
    expect(service.log({}).entries[0]).toMatchObject({ endpoint: 'weather', targets: [] });
  });

  it('rain while it rains is 409 already_raining and uses no budget (Q3)', () => {
    const { pw, service } = world();
    expect(service.apply(rain(1)).ok).toBe(true);
    const until = pw.weather.until;
    expect(service.apply(rain(3))).toEqual({ ok: false, status: 409, error: 'already_raining' });
    expect(pw.weather.until).toBe(until);
    expect(service.budget().usedToday).toBe(1);
    expect(service.log({}).entries).toHaveLength(1);
  });

  it('clear stops the rain, swaps blocks back and records the end on the rain entry', () => {
    const { host, pw, service, town } = world();
    host.states.find((v) => v.id === 'ada')!.plan = plan();
    service.apply(rain(3));
    const rainId = pw.events.active().find((e) => e.kind === 'rain')!.id;
    advance(host, pw, 15);
    const res = service.apply(clear);
    expect(res).toMatchObject({ ok: true, refs: { worldEventId: rainId } });
    expect(pw.weather.state).toBe('clear');
    expect(blocksOf(host, 'ada')).toEqual(['park', 'park', 'square', 'square', 'bakery']);
    expect(outcomes(service, 0)).toEqual({ startedAt: 480, endedAt: 495, swaps: 2 });
    expect(outcomes(service, 1)).toEqual({ endedAt: 495, swaps: 0 });
    expect(town.at(-1)).toBe('The rain was cleared [influence]');
    expect(service.budget().usedToday).toBe(2);
  });

  it('clear while it is not raining is 409 not_raining and uses no budget', () => {
    const { service } = world();
    expect(service.apply(clear)).toEqual({ ok: false, status: 409, error: 'not_raining' });
    expect(service.budget().usedToday).toBe(0);
    expect(service.log({}).entries).toEqual([]);
  });

  it('also clears rain that did not come from an influence', () => {
    const { pw, service } = world();
    pw.handleCommand({ type: 'world.trigger', kind: 'rain' });
    expect(service.apply(clear).ok).toBe(true);
    expect(pw.weather.state).toBe('clear');
  });

  it('counts blocks swapped later in the rain and records the natural end', () => {
    const { host, pw, service } = world();
    service.apply(rain(1));
    expect(outcomes(service, 0).swaps).toBe(0);
    host.states.find((v) => v.id === 'ben')!.plan = plan();
    advance(host, pw, 1);
    expect(outcomes(service, 0).swaps).toBe(2);
    advance(host, pw, 60);
    expect(pw.weather.state).toBe('clear');
    expect(outcomes(service, 0)).toEqual({ startedAt: 480, endedAt: 540, swaps: 2 });
    expect(blocksOf(host, 'ben')).toEqual(['park', 'park', 'square', 'square', 'bakery']);
  });

  it('refuses hours outside 1-3 from direct callers with 422 and changes nothing', () => {
    const { pw, service } = world();
    for (const hours of [0, 4, 1.5, Number.NaN])
      expect(service.apply(rain(hours))).toMatchObject({ ok: false, status: 422, field: 'hours' });
    expect(pw.weather.state).toBe('clear');
    expect(service.budget().usedToday).toBe(0);
  });

  it('resumes tracking a restored rain: later swaps and the end land on the restored entry', () => {
    const a = world();
    a.service.apply(rain(2));
    advance(a.host, a.pw, 10);
    const saved = JSON.parse(
      JSON.stringify({ pw: a.pw.serialize(), influence: a.service.serialize(), time: a.host.time }),
    );
    const b = world(saved);
    expect(b.pw.weather.state).toBe('rain');
    b.host.states.find((v) => v.id === 'cy')!.plan = plan();
    advance(b.host, b.pw, 1);
    expect(outcomes(b.service, 0).swaps).toBe(2);
    expect(b.service.apply(clear).ok).toBe(true);
    expect(outcomes(b.service, 0)).toEqual({ startedAt: 480, endedAt: 491, swaps: 2 });
    expect(blocksOf(b.host, 'cy')).toEqual(['park', 'park', 'square', 'square', 'bakery']);
  });

  it('leaves ended or foreign restored entries alone', () => {
    const a = world();
    a.service.apply(rain(1));
    a.service.apply(clear);
    const saved = JSON.parse(
      JSON.stringify({ pw: a.pw.serialize(), influence: a.service.serialize(), time: a.host.time }),
    );
    saved.influence.entries.push({
      ...saved.influence.entries[0],
      id: 'inf_9',
      refs: { worldEventId: 'we_x' },
      outcomes: { swaps: 0 },
    });
    const b = world(saved);
    expect(b.service.log({}).entries.map((e) => e.outcomes)).toEqual(
      saved.influence.entries.map((e: { outcomes: unknown }) => e.outcomes),
    );
  });
});
