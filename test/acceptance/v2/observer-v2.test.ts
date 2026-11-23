/** AC27: the observer API exposes the v2 world (spec v2 §17). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../../../src/server/net/server.ts';
import type { SaveData } from '../../../src/server/persistence/types.ts';
import { Engine } from '../../../src/server/sim/engine.ts';
import { at } from '../../../src/shared/time.ts';
import type { KeepEntryKind, LetterStatus, Romance } from '../../../src/shared/types.ts';
import { readyV2, waitingForV2, type Feature } from '../../helpers/features.ts';
import { loc, V2, walkPlayerTo } from '../../helpers/v2.ts';
import { createTestWorld, mutualAffinity, type TestWorld } from '../../helpers/world.ts';

const F: Feature[] = [...V2.animals, ...V2.farm, ...V2.visitors, ...V2.romance, ...V2.post, 'villagers'];

const PAIR = ['ivy', 'sam'] as const;
const LETTER = 'Shall we go and see the penguins together on Sunday?';
const NOTICE = 'Wanted: volunteers to paint the old station bench.';
const LETTER_STATUSES: LetterStatus[] = ['posted', 'delivered', 'read', 'replied', 'returned'];
const KEEP_KINDS: KeepEntryKind[] = ['note', 'letter', 'notice', 'rumor', 'reply'];
const AGENT_KINDS = ['villager', 'visitor', 'stranger', 'player'];
const ROMANCE_KINDS = ['crush', 'shy_crush', 'dating', 'partner'];
const V2_PATHS = ['/api/letters', '/api/notices', '/api/keep', '/api/animals'];
const V1_PATHS = ['/api/state', '/api/conversations', '/api/notes', '/api/events', '/api/stats'];

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
function recs(v: unknown): Rec[] {
  if (!Array.isArray(v)) throw new Error(`expected a JSON array, got ${JSON.stringify(v)?.slice(0, 200)}`);
  return v.filter(isRec);
}
const str = (r: Rec, k: string) => (typeof r[k] === 'string' ? r[k] : undefined);

/** Romance seeded through the save, so dates follow from the pair's next conversations. */
function scriptedRomance(save: SaveData): void {
  const romance: Romance = {
    id: `romance-${PAIR[0]}-${PAIR[1]}`,
    pair: [PAIR[0], PAIR[1]],
    stage: 'crush',
    since: save.time,
    crushFrom: [PAIR[0], PAIR[1]],
    dates: [],
    updatedAt: save.time,
  };
  save.romances = [...(save.romances ?? []).filter((r) => r.id !== romance.id), romance];
}

describe.skipIf(!readyV2(...F))(`AC27: observer API v2${waitingForV2(...F)}`, () => {
  let w: TestWorld;
  let engine: Engine;
  let server: RunningServer;
  let base = '';
  const occurred = new Map<string, boolean>();

  const get = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${base}${path}`, init);
    const type = res.headers.get('content-type') ?? '';
    const body: unknown = type.includes('json') ? await res.json() : null;
    return { res, body };
  };
  const list = async (path: string) => {
    const { res, body } = await get(path);
    expect(res.status, path).toBe(200);
    return recs(body);
  };

  beforeAll(async () => {
    w = await createTestWorld({
      villagers: 12,
      startAt: '06:00',
      seed: 27,
      affinities: mutualAffinity(PAIR[0], PAIR[1], 7),
      patchSave: scriptedRomance,
      config: { observer: { logSize: 100_000 } },
    });
    if (!(w.engine instanceof Engine)) throw new Error('the observer needs the real engine');
    engine = w.engine;
    const map = engine.map;
    if (!(await walkPlayerTo(w, loc(map, 'post_office').entry)))
      throw new Error('cannot reach the post office');
    w.command({ type: 'letter.send', to: 'mia', text: LETTER });
    if (!(await walkPlayerTo(w, loc(map, 'notice_board').entry)))
      throw new Error('cannot reach the notice board');
    w.command({ type: 'notice.post', text: NOTICE });
    await w.advanceTo(at(3, '06:00'));

    const s = w.state();
    occurred.set(
      'train_arrived',
      w.of('train.updated').some((m) => m.train.status === 'boarding'),
    );
    occurred.set(
      'train_departed',
      w.of('train.updated').some((m) => m.train.status === 'departing'),
    );
    occurred.set('visitor_arrived', w.of('visitor.updated').length > 0);
    occurred.set(
      'visitor_checked_in',
      w.of('visitor.updated').some((m) => m.visitor.status === 'checkedIn'),
    );
    occurred.set(
      'animal_born',
      w.of('animals.changed').some((m) => m.added.some((a) => a.group === 'farm')),
    );
    occurred.set(
      'animal_butchered',
      w.of('animals.changed').some((m) => m.removed.some((a) => a.reason === 'butcher')),
    );
    occurred.set(
      'animal_died',
      w.of('animals.changed').some((m) => m.removed.some((a) => a.reason === 'oldAge')),
    );
    occurred.set(
      'letter_sent',
      w.of('letter.updated').some((m) => m.letter.status === 'posted'),
    );
    occurred.set(
      'letter_delivered',
      w.of('letter.updated').some((m) => m.letter.status === 'delivered'),
    );
    occurred.set(
      'notice_posted',
      w.of('notice.updated').some((m) => !m.removed),
    );
    occurred.set(
      'date',
      s.events.some((e) => e.kind === 'date' && e.status === 'done'),
    );
    occurred.set(
      'couple',
      (s.romances ?? []).some((r) => r.stage === 'couple'),
    );

    server = await startServer({
      host: '127.0.0.1',
      port: 0,
      staticDir: 'dist/client',
      debug: false,
      llm: { provider: 'mock', model: 'mock-model', embeddings: null },
      engine,
      observer: { config: engine.config.observer, source: engine },
    });
    base = server.observerUrl ?? `http://127.0.0.1:${server.port}`;
  }, 600_000);

  afterAll(async () => {
    await server?.close();
    w?.dispose();
  });

  it('/api/events contains each new event type that occurred over 3 days', async () => {
    for (const t of ['train_arrived', 'visitor_arrived', 'letter_sent', 'notice_posted'])
      expect(occurred.get(t), `${t} happened`).toBe(true);
    expect(occurred.get('date') || occurred.get('couple'), 'a date or a couple in the scripted world').toBe(
      true,
    );
    for (const [type, happened] of occurred) {
      if (!happened) continue;
      const { res, body } = await get(`/api/events?type=${type}&limit=1000`);
      expect(res.status, type).toBe(200);
      const entries = recs(body);
      expect(entries.length, `${type} in the town log`).toBeGreaterThanOrEqual(1);
      expect(entries.every((e) => e.type === type)).toBe(true);
    }
    for (const type of ['date', 'couple']) {
      if (occurred.get(type)) continue;
      expect((await get(`/api/events?type=${type}`)).res.status, `${type} is a known type`).toBe(200);
    }
  });

  it('/api/letters returns the documented shape with agent, since and limit', async () => {
    const all = await list('/api/letters?limit=1000');
    expect(all.length).toBeGreaterThanOrEqual(1);
    for (const l of all) {
      expect(Date.parse(str(l, 'ts') ?? '')).not.toBeNaN();
      expect(typeof l.day).toBe('number');
      expect(str(l, 'time')).toMatch(/^\d{2}:\d{2}$/);
      for (const k of ['from', 'to', 'text']) expect(typeof l[k], k).toBe('string');
      expect(LETTER_STATUSES).toContain(str(l, 'status'));
      if ('reply' in l) expect(typeof l.reply).toBe('string');
    }
    expect(all.some((l) => l.from === 'player' && l.to === 'mia' && l.text === LETTER)).toBe(true);
    const mine = await list('/api/letters?agent=mia');
    expect(mine.length).toBeGreaterThanOrEqual(1);
    expect(mine.every((l) => l.from === 'mia' || l.to === 'mia')).toBe(true);
    expect((await list('/api/letters?limit=1')).length).toBeLessThanOrEqual(1);
    expect(await list(`/api/letters?since=${engine.now() + 1}`)).toEqual([]);
  });

  it('/api/notices returns the active notices', async () => {
    const notices = await list('/api/notices');
    const active = (w.state().notices ?? []).filter((n) => n.expiresAt > engine.now());
    expect(notices).toHaveLength(active.length);
    expect(notices.length).toBeLessThanOrEqual(engine.config.post.maxNotices);
    for (const n of notices) expect(typeof n.text).toBe('string');
    expect(notices.some((n) => n.text === NOTICE)).toBe(true);
  });

  it('/api/keep returns Keep entries with kind, q, since and limit', async () => {
    const all = await list('/api/keep?limit=1000');
    expect(all.length).toBeGreaterThanOrEqual(2);
    for (const e of all) {
      expect(KEEP_KINDS).toContain(str(e, 'kind'));
      expect(typeof e.text).toBe('string');
    }
    const letters = await list('/api/keep?kind=letter');
    expect(letters.length).toBeGreaterThanOrEqual(1);
    expect(letters.every((e) => e.kind === 'letter')).toBe(true);
    const found = await list('/api/keep?q=penguins');
    expect(found.length).toBeGreaterThanOrEqual(1);
    expect(found.every((e) => /penguins/i.test(str(e, 'text') ?? ''))).toBe(true);
    expect((await list('/api/keep?limit=2')).length).toBeLessThanOrEqual(2);
    expect(await list(`/api/keep?since=${engine.now() + 1}`)).toEqual([]);
  });

  it('/api/animals returns the documented shape with group and species filters', async () => {
    const animals = w.state().animals ?? [];
    const all = await list('/api/animals');
    expect(all).toHaveLength(animals.length);
    for (const a of all) {
      for (const k of ['id', 'species', 'group', 'location', 'status']) expect(typeof a[k], k).toBe('string');
      for (const k of ['x', 'y']) expect(typeof a[k], k).toBe('number');
    }
    const farm = await list('/api/animals?group=farm');
    expect(farm).toHaveLength(animals.filter((a) => a.group === 'farm').length);
    expect(farm.every((a) => a.group === 'farm' && typeof a.stage === 'string')).toBe(true);
    const cows = await list('/api/animals?species=cow');
    expect(cows.length).toBeGreaterThanOrEqual(1);
    expect(cows.every((a) => a.species === 'cow')).toBe(true);
  });

  it('agents carry a kind, /api/state has the v2 fields, and romance relationship kinds appear', async () => {
    const { body } = await get('/api/state');
    if (!isRec(body)) throw new Error('state is not an object');
    for (const k of ['train', 'hotel', 'visitors', 'farm', 'stock']) expect(body, k).toHaveProperty(k);
    const agents = recs(body.agents);
    expect(agents.every((a) => AGENT_KINDS.includes(str(a, 'kind') ?? ''))).toBe(true);
    const visitors = new Set((w.state().visitors ?? []).map((v) => v.villagerId));
    const visitorAgents = agents.filter((a) => visitors.has(str(a, 'id') ?? ''));
    expect(visitorAgents.length, 'visitors in /api/state').toBeGreaterThanOrEqual(1);
    expect(visitorAgents.every((a) => a.kind === 'visitor')).toBe(true);

    const relKind = async (id: string, other: string) => {
      const { body: agent } = await get(`/api/agents/${id}`);
      if (!isRec(agent)) throw new Error(`agent ${id} is not an object`);
      expect(agent, `${id}.romance`).toHaveProperty('romance');
      return str(recs(agent.relationships).find((r) => r.with === other) ?? {}, 'kind');
    };
    expect(ROMANCE_KINDS).toContain(await relKind(PAIR[0], PAIR[1]));
    expect(ROMANCE_KINDS).toContain(await relKind(PAIR[1], PAIR[0]));
    expect(await relKind('laude', 'franzi')).toBe('shy_crush');
  });

  it('stays GET-only and a full crawl leaves the sim unchanged', async () => {
    for (const path of V2_PATHS)
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const res = await fetch(`${base}${path}`, { method, body: method === 'DELETE' ? null : '{}' });
        expect(res.status, `${method} ${path}`).toBe(405);
      }
    const strip = (s: SaveData) => JSON.stringify({ ...s, savedAt: '', observer: { log: s.observer?.log } });
    const snapshot = JSON.stringify(engine.snapshot());
    const save = strip(engine.toSaveData());
    const q0 = engine.queue.stats();
    const ids = engine.villagerIds();
    const paths = [
      ...V1_PATHS,
      ...V2_PATHS,
      '/api/events?limit=1000',
      '/api/letters?limit=1000',
      '/api/keep?limit=1000&kind=letter&q=penguins',
      '/api/animals?group=zoo',
      ...ids.flatMap((id) => [`/api/agents/${id}`, `/api/agents/${id}/memories?limit=500`]),
    ];
    for (const p of paths) expect((await get(p)).res.status, p).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    const q1 = engine.queue.stats();
    expect(q1.done + q1.failed + q1.queued + q1.running).toBe(q0.done + q0.failed + q0.queued + q0.running);
    expect(JSON.stringify(engine.snapshot())).toBe(snapshot);
    expect(strip(engine.toSaveData())).toBe(save);
  });
});
