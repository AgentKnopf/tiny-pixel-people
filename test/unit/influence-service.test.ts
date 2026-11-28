/** TASK-18 I1: influence service — day budget, bounded log, save/restore, 503/429 decisions (spec §3, §6, §7). */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ConfigError, DEFAULT_CONFIG, loadConfig, type PartialConfig } from '../../src/server/config.ts';
import { ObserverViews } from '../../src/server/net/observer-views.ts';
import { queueBusyAt, type InfluenceHandler } from '../../src/server/sim/influence.ts';
import type { InfluenceEndpoint, InfluenceOutcomes, InfluenceRequest } from '../../src/shared/influence.ts';
import { at, MINUTES_PER_DAY } from '../../src/shared/time.ts';
import { createSimTestWorld } from '../helpers/sim.ts';

const rain: InfluenceRequest = { endpoint: 'weather', body: { weather: 'rain', hours: 2 } };

/** A handler that accepts every call; a stand-in for the endpoint handlers of I3-I7. */
function accepting(outcomes: InfluenceOutcomes['weather'] = { swaps: 0 }): InfluenceHandler<'weather'> {
  return {
    check: () => ({
      targets: [],
      text: 'The sky clouded over',
      outcomes: structuredClone(outcomes),
      apply: (id) => ({ refs: { worldEventId: `we_${id}` } }),
    }),
  };
}

function world(config: PartialConfig = {}, extra: Parameters<typeof createSimTestWorld>[0] = {}) {
  const w = createSimTestWorld({ config: { influence: { enabled: true }, ...config }, ...extra });
  w.engine.influence.register('weather', accepting());
  return w;
}

const apply = (w: ReturnType<typeof world>, req: InfluenceRequest = rain) => w.engine.applyInfluence(req);

describe('influence config', () => {
  const load = (influence: unknown) =>
    loadConfig({
      env: {},
      cwd: mkdtempSync(join(tmpdir(), 'tpp-inf-cfg-')),
      overrides: { influence } as PartialConfig,
    });

  it('defaults to off, 6 a day and a 500-entry log; no token in this section yet', () => {
    expect(DEFAULT_CONFIG.influence).toEqual({ enabled: false, perGameDay: 6, logMax: 500 });
  });

  it('accepts 0 (no limit) and 1000, refuses -1, 1.5 and 1001 at startup', () => {
    expect(load({ perGameDay: 0 }).influence.perGameDay).toBe(0);
    expect(load({ perGameDay: 1000 }).influence.perGameDay).toBe(1000);
    for (const bad of [-1, 1.5, 1001])
      expect(() => load({ perGameDay: bad }), String(bad)).toThrow(ConfigError);
  });

  it('keeps logMax within 50-5000', () => {
    expect(load({ logMax: 50 }).influence.logMax).toBe(50);
    for (const bad of [49, 5001, 100.5])
      expect(() => load({ logMax: bad }), String(bad)).toThrow(ConfigError);
  });
});

describe('day budget', () => {
  it('accepts 6 a game day, then answers 429 with the next midnight', () => {
    const w = world();
    for (let i = 1; i <= 6; i++) expect(apply(w)).toMatchObject({ ok: true, id: `inf_${i}` });
    expect(apply(w)).toEqual({ ok: false, status: 429, error: 'limit', resetsAtTick: MINUTES_PER_DAY });
    expect(w.engine.influenceLog({}).budget).toEqual({
      limit: 6,
      usedToday: 6,
      resetsAtTick: MINUTES_PER_DAY,
    });
    expect(w.engine.influenceLog({}).entries).toHaveLength(6);
  });

  it('does not count refusals', () => {
    const w = world();
    let refuse = true;
    w.engine.influence.register('nudge', {
      check: () =>
        refuse
          ? { status: 409, error: 'asleep', wakesAt: at(0, '07:00') }
          : { targets: ['mia'], text: 'x', outcomes: {}, apply: () => ({ refs: {} }) },
    });
    const nudge: InfluenceRequest = { endpoint: 'nudge', body: { agent: 'mia', thought: 'hm' } };
    for (let i = 0; i < 5; i++) expect(apply(w)).toMatchObject({ ok: true });
    for (let i = 0; i < 3; i++)
      expect(apply(w, nudge)).toMatchObject({ ok: false, status: 409, error: 'asleep' });
    expect(w.engine.influenceLog({}).budget.usedToday).toBe(5);
    refuse = false;
    expect(apply(w, nudge)).toMatchObject({ ok: true, id: 'inf_6' });
    expect(apply(w)).toMatchObject({ ok: false, status: 429 });
  });

  it('perGameDay 0 lets 20 calls through and logs all 20', () => {
    const w = world({ influence: { enabled: true, perGameDay: 0 } });
    for (let i = 0; i < 20; i++) expect(apply(w)).toMatchObject({ ok: true });
    const page = w.engine.influenceLog({ limit: 200 });
    expect(page.entries).toHaveLength(20);
    expect(page.budget).toEqual({ limit: 0, usedToday: 20, resetsAtTick: MINUTES_PER_DAY });
  });

  it('resets at midnight', async () => {
    const w = world({}, { startAt: '23:00' });
    for (let i = 0; i < 6; i++) apply(w);
    expect(apply(w)).toMatchObject({ status: 429 });
    await w.engine.advance(61);
    expect(apply(w)).toMatchObject({ ok: true });
    expect(w.engine.influenceLog({}).budget).toEqual({
      limit: 6,
      usedToday: 1,
      resetsAtTick: 2 * MINUTES_PER_DAY,
    });
  });

  it('an endpoint without a handler is refused with 422 and not counted', () => {
    const w = world();
    const res = apply(w, { endpoint: 'rumour', body: { to: 'mia', text: 'hi', source: 'crow' } });
    expect(res).toMatchObject({ ok: false, status: 422, error: 'invalid' });
    expect(w.engine.influenceLog({}).budget.usedToday).toBe(0);
  });
});

describe('overload', () => {
  it('answers 503 busy after the handler checks and before the budget, without counting', () => {
    const w = world({ influence: { enabled: true, perGameDay: 1 } });
    const busy = vi.spyOn(w.engine, 'influenceBusy').mockReturnValue(true);
    expect(apply(w)).toEqual({ ok: false, status: 503, error: 'busy' });
    busy.mockReturnValue(false);
    expect(apply(w)).toMatchObject({ ok: true });
    busy.mockReturnValue(true);
    // Budget used up and busy: 503 comes first (spec §3 order 9 before 10).
    expect(apply(w)).toMatchObject({ status: 503 });
    w.engine.influence.register('nudge', {
      check: () => ({ status: 422, error: 'invalid', message: 'Unknown villager', field: 'agent' }),
    });
    expect(apply(w, { endpoint: 'nudge', body: { agent: 'zed', thought: 'x' } })).toMatchObject({
      status: 422,
    });
    expect(w.engine.influenceLog({}).budget.usedToday).toBe(1);
  });

  it('is not busy in a quiet test world', () => {
    expect(world().engine.influenceBusy()).toBe(false);
  });
});

describe('influence log', () => {
  it('records the entry, a town log line and a replay log message', async () => {
    const w = world();
    const res = w.engine.applyInfluence(rain, { ts: '2030-01-01T00:00:00.000Z' });
    expect(res).toEqual({ ok: true, id: 'inf_1', tick: at(0, '06:00'), refs: { worldEventId: 'we_inf_1' } });
    expect(w.engine.influenceLog({}).entries).toEqual([
      {
        id: 'inf_1',
        tick: at(0, '06:00'),
        ts: '2030-01-01T00:00:00.000Z',
        day: 1,
        time: '06:00',
        endpoint: 'weather',
        payload: { weather: 'rain', hours: 2 },
        targets: [],
        refs: { worldEventId: 'we_inf_1' },
        outcomes: { swaps: 0 },
      },
    ]);
    const town = w.engine.townLog.list().filter((e) => e.type === 'influence');
    expect(town).toHaveLength(1);
    expect(town[0]).toMatchObject({
      text: 'The sky clouded over [influence]',
      data: { influenceId: 'inf_1', endpoint: 'weather' },
    });
    const logMsgs = w.messages.filter((m) => m.type === 'log' && m.text.includes('[influence]'));
    expect(logMsgs).toHaveLength(1);
    await vi.waitFor(() => {
      const file = w.engine.store.replayPath;
      expect(existsSync(file) && readFileSync(file, 'utf8')).toContain('The sky clouded over [influence]');
    });
  });

  it("stores a copy of the body, not the caller's object", () => {
    const w = world();
    const body = { weather: 'rain' as const, hours: 2 };
    w.engine.applyInfluence({ endpoint: 'weather', body });
    body.hours = 3;
    expect(w.engine.influenceLog({}).entries[0]!.payload).toEqual({ weather: 'rain', hours: 2 });
  });

  it('marks visitors and lists targets', () => {
    const w = world();
    w.engine.influence.register('nudge', {
      check: () => ({
        targets: ['mia'],
        visitor: true,
        text: 'x',
        outcomes: {},
        apply: () => ({ refs: {} }),
      }),
    });
    w.engine.applyInfluence({ endpoint: 'nudge', body: { agent: 'mia', thought: 'hm' } });
    expect(w.engine.influenceLog({}).entries[0]).toMatchObject({ targets: ['mia'], visitor: true });
  });

  it('is bounded at logMax, dropping the oldest with an info line', () => {
    const info = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const w = world({ influence: { enabled: true, perGameDay: 0, logMax: 50 } });
      for (let i = 0; i < 60; i++) apply(w);
      const entries = w.engine.influenceLog({ limit: 200 }).entries;
      expect(entries).toHaveLength(50);
      expect(entries[0]!.id).toBe('inf_11');
      expect(entries.at(-1)!.id).toBe('inf_60');
      expect(info.mock.calls.some(([l]) => /influence log full/.test(String(l)))).toBe(true);
    } finally {
      info.mockRestore();
    }
  });

  it('pages by tick or timestamp, newest page without since, at most 200', async () => {
    const w = world({ influence: { enabled: true, perGameDay: 0 } });
    for (let i = 0; i < 5; i++) {
      w.engine.applyInfluence(rain, { ts: `2030-01-01T00:0${i}:00.000Z` });
      await w.engine.advance(10);
    }
    const ids = (q: Parameters<typeof w.engine.influenceLog>[0]) =>
      w.engine.influenceLog(q).entries.map((e) => e.id);
    expect(ids({ limit: 2 })).toEqual(['inf_4', 'inf_5']);
    expect(ids({ since: at(0, '06:10'), limit: 2 })).toEqual(['inf_3', 'inf_4']);
    expect(ids({ since: '2030-01-01T00:02:00.000Z' })).toEqual(['inf_4', 'inf_5']);
    expect(w.engine.influenceLog({ since: at(0, '06:10'), limit: 2 }).nextSince).toBe(
      '2030-01-01T00:03:00.000Z',
    );
    expect(w.engine.influenceLog({ since: at(1, '00:00') }).nextSince).toBeUndefined();
    const many = world({ influence: { enabled: true, perGameDay: 0, logMax: 500 } });
    for (let i = 0; i < 250; i++) many.engine.applyInfluence(rain);
    expect(many.engine.influenceLog({ limit: 1000 }).entries).toHaveLength(200);
    expect(() => w.engine.influenceLog({ since: 'not a time' })).toThrow(RangeError);
  });

  it('outcome updates land on the entry', () => {
    const w = world();
    const res = apply(w);
    if (!res.ok) throw new Error('refused');
    w.engine.influence.updateOutcomes('weather', res.id, (o) => {
      o.swaps = 4;
      o.endedAt = at(0, '08:00');
    });
    w.engine.influence.updateOutcomes('weather', 'inf_999', (o) => (o.swaps = 1));
    expect(w.engine.influenceLog({}).entries[0]!.outcomes).toEqual({ swaps: 4, endedAt: at(0, '08:00') });
  });
});

describe('save and restore', () => {
  it('keeps the log, outcomes, counter and id sequence; the 7th call of the day still gets 429', () => {
    const a = world();
    for (let i = 0; i < 6; i++) apply(a);
    a.engine.influence.updateOutcomes('weather', 'inf_2', (o) => (o.swaps = 3));
    const save = a.engine.toSaveData();
    expect(save.influence).toMatchObject({ day: 0, used: 6, nextId: 7 });

    const b = world({}, { restore: structuredClone(save) });
    expect(b.engine.influenceLog({}).entries).toEqual(a.engine.influenceLog({}).entries);
    expect(b.engine.influenceLog({}).entries[1]!.outcomes).toEqual({ swaps: 3 });
    expect(apply(b)).toMatchObject({ ok: false, status: 429 });

    const c = world({ influence: { enabled: true, perGameDay: 10 } }, { restore: structuredClone(save) });
    expect(apply(c)).toMatchObject({ ok: true, id: 'inf_7' });
  });

  it("a lower limit after restore than today's usage gives 429", () => {
    const a = world();
    for (let i = 0; i < 5; i++) apply(a);
    const b = world({ influence: { enabled: true, perGameDay: 3 } }, { restore: a.engine.toSaveData() });
    expect(apply(b)).toMatchObject({ status: 429 });
    expect(b.engine.influenceLog({}).budget).toMatchObject({ limit: 3, usedToday: 5 });
  });

  it('a save from an earlier day does not carry its count into today', () => {
    const a = world();
    for (let i = 0; i < 6; i++) apply(a);
    const save = a.engine.toSaveData();
    save.time = at(2, '09:00');
    const b = world({}, { restore: save });
    expect(apply(b)).toMatchObject({ ok: true, id: 'inf_7' });
    expect(b.engine.influenceLog({}).budget.usedToday).toBe(1);
  });

  it('a save without the influence field starts empty', () => {
    const save = world().engine.toSaveData();
    delete save.influence;
    const b = world({}, { restore: save });
    expect(b.engine.influenceLog({}).entries).toEqual([]);
    expect(apply(b)).toMatchObject({ ok: true, id: 'inf_1' });
  });

  it('a smaller logMax after restore keeps the newest entries; nextId never goes back', () => {
    const a = world({ influence: { enabled: true, perGameDay: 0, logMax: 500 } });
    for (let i = 0; i < 80; i++) apply(a);
    const b = world(
      { influence: { enabled: true, perGameDay: 0, logMax: 50 } },
      { restore: a.engine.toSaveData() },
    );
    const entries = b.engine.influenceLog({ limit: 200 }).entries;
    expect(entries).toHaveLength(50);
    expect(entries[0]!.id).toBe('inf_31');
    expect(apply(b)).toMatchObject({ id: 'inf_81' });
  });

  it('hands restored entries to the endpoint handler when it registers, so it can keep tracking outcomes', () => {
    const a = world();
    apply(a);
    apply(a);
    const b = createSimTestWorld({
      config: { influence: { enabled: true } },
      restore: a.engine.toSaveData(),
    });
    const resumed: string[] = [];
    b.engine.influence.register('weather', { ...accepting(), resume: (e) => resumed.push(e.id) });
    expect(resumed).toEqual(['inf_1', 'inf_2']);
  });
});

describe('stats', () => {
  it('/api/stats shows the budget', () => {
    const w = world();
    apply(w);
    const views = new ObserverViews(w.engine, { provider: 'mock', model: 'm' });
    expect(views.stats().influence).toEqual({ limit: 6, usedToday: 1, resetsAtTick: MINUTES_PER_DAY });
  });

  it('shows null while the influence API is off', () => {
    const { engine } = createSimTestWorld();
    expect(new ObserverViews(engine, { provider: 'mock', model: 'm' }).stats().influence).toBeNull();
  });
});

const _endpointsTyped: InfluenceEndpoint = 'weather';
void _endpointsTyped;

describe('review follow-ups', () => {
  it('F1: an outcome update made inside apply() is kept', () => {
    const w = world();
    w.engine.influence.register('weather', {
      check: () => ({
        targets: [],
        text: 'Rain',
        outcomes: { swaps: 0 },
        apply: (id) => {
          w.engine.influence.updateOutcomes('weather', id, (o) => (o.swaps = 9));
          return { refs: {} };
        },
      }),
    });
    expect(apply(w)).toMatchObject({ ok: true });
    expect(w.engine.influenceLog({}).entries[0]!.outcomes).toEqual({ swaps: 9 });
  });

  it('F2: an error in apply() is logged with id and endpoint, rethrown, and leaves no entry or count', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const w = world();
      w.engine.influence.register('weather', {
        check: () => ({
          targets: [],
          text: 'Rain',
          outcomes: { swaps: 0 },
          apply: () => {
            throw new Error('boom');
          },
        }),
      });
      expect(() => apply(w)).toThrow('boom');
      expect(err.mock.calls.some(([l]) => /inf_1/.test(String(l)) && /weather/.test(String(l)))).toBe(true);
      expect(w.engine.influenceLog({}).entries).toEqual([]);
      expect(w.engine.influenceLog({}).budget.usedToday).toBe(0);
      expect(w.engine.townLog.list().some((e) => e.type === 'influence')).toBe(false);
      w.engine.influence.register('weather', accepting());
      // Ids are never reused, so the error line's id stays unique.
      expect(apply(w)).toMatchObject({ ok: true, id: 'inf_2' });
    } finally {
      err.mockRestore();
    }
  });

  it('F4: the entry ts is its town log entry ts; a passed-in ts moves the increasing clock forward', () => {
    const w = world({ influence: { enabled: true, perGameDay: 0 } });
    apply(w);
    const town = w.engine.townLog.list().filter((e) => e.type === 'influence');
    expect(w.engine.influenceLog({}).entries[0]!.ts).toBe(town[0]!.ts);
    w.engine.applyInfluence(rain, { ts: '2099-01-01T00:00:00.000Z' });
    apply(w);
    const entries = w.engine.influenceLog({}).entries;
    expect(Date.parse(entries[2]!.ts)).toBeGreaterThan(Date.parse('2099-01-01T00:00:00.000Z'));
    expect(w.engine.influenceLog({ since: '2099-01-01T00:00:00.000Z' }).entries.map((e) => e.id)).toEqual([
      'inf_3',
    ]);
  });

  it('F5: a saved block without entries keeps its counter and ids', () => {
    const save = world().engine.toSaveData();
    save.influence = { day: 0, used: 6, nextId: 7 } as unknown as NonNullable<typeof save.influence>;
    const b = world({}, { restore: save });
    expect(b.engine.influenceLog({}).budget.usedToday).toBe(6);
    expect(apply(b)).toMatchObject({ status: 429 });
    const c = world({ influence: { enabled: true, perGameDay: 10 } }, { restore: structuredClone(save) });
    expect(apply(c)).toMatchObject({ ok: true, id: 'inf_7' });
  });

  it('F3: busy once the LLM queue is within 16 jobs of full', () => {
    const w = world();
    expect(w.engine.queue.maxQueued).toBe(64);
    const real = w.engine.queue.stats();
    const stats = vi.spyOn(w.engine.queue, 'stats');
    stats.mockReturnValue({ ...real, queued: 47 });
    expect(w.engine.influenceBusy()).toBe(false);
    stats.mockReturnValue({ ...real, queued: 48 });
    expect(w.engine.influenceBusy()).toBe(true);
    expect(apply(w)).toEqual({ ok: false, status: 503, error: 'busy' });
  });

  it('F3: a small queue cap still leaves room (75% or cap - 16, whichever is higher)', () => {
    expect([1, 2, 8, 16, 20, 64, 100].map(queueBusyAt)).toEqual([1, 2, 6, 12, 15, 48, 84]);
    const w = world();
    vi.spyOn(w.engine.queue, 'maxQueued', 'get').mockReturnValue(8);
    const real = w.engine.queue.stats();
    const stats = vi.spyOn(w.engine.queue, 'stats');
    stats.mockReturnValue({ ...real, queued: 5 });
    expect(w.engine.influenceBusy()).toBe(false);
    stats.mockReturnValue({ ...real, queued: 6 });
    expect(w.engine.influenceBusy()).toBe(true);
  });
});
