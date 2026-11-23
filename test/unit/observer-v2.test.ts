import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../../src/server/net/server.ts';
import type { Engine } from '../../src/server/sim/engine.ts';
import { TOWN_EVENT_TYPES } from '../../src/server/sim/town-log.ts';
import { PLAYER_ID, type Romance } from '../../src/shared/types.ts';
import { createSimTestWorld } from '../helpers/sim.ts';

type Json = Record<string, unknown> & Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const running: { server: RunningServer; engine: Engine }[] = [];

afterEach(async () => {
  for (const r of running.splice(0)) {
    r.engine.stop();
    await r.server.close();
  }
});

async function boot(engine: Engine) {
  const server = await startServer({
    host: '127.0.0.1',
    port: 0,
    staticDir: 'dist/client',
    debug: false,
    llm: { provider: 'mock', model: 'mock-model', embeddings: null },
    engine,
    observer: { config: engine.config.observer, source: engine },
  });
  running.push({ server, engine });
  const base = server.observerUrl ?? `http://127.0.0.1:${server.port}`;
  const get = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${base}${path}`, init);
    const type = res.headers.get('content-type') ?? '';
    const body = type.includes('json') ? ((await res.json()) as Json) : null;
    return { res, body };
  };
  const list = async (path: string) => {
    const { res, body } = await get(path);
    expect(res.status, path).toBe(200);
    expect(Array.isArray(body), path).toBe(true);
    return body as unknown as Json[];
  };
  return { base, get, list };
}

const LETTER = 'Would you like to see the penguins with me on Sunday?';
const NOTICE = 'Lost: a blue scarf near the bakery.';

/** A world with a letter, a reply, a notice, a dating pair and two days of trains, animals and rides. */
async function busyWorld() {
  const { engine } = createSimTestWorld({ startAt: '06:00' });
  const ids = engine.villagerIds();
  const [a, b] = ['mia', 'sam'].every((id) => ids.includes(id)) ? ['mia', 'sam'] : [ids[0]!, ids[1]!];
  const letter = engine.playerWorld.postLetter(PLAYER_ID, a!, LETTER);
  expect(letter).not.toBeNull();
  engine.playerWorld.postLetter(a!, PLAYER_ID, 'Yes please, I love penguins!', { replyTo: letter!.id });
  const notice = engine.playerWorld.post.postNotice(PLAYER_ID, NOTICE, engine.now());
  expect('id' in notice).toBe(true);
  const pair = [a!, b!].sort() as [string, string];
  const romance: Romance = {
    id: `romance-${pair[0]}-${pair[1]}`,
    pair,
    stage: 'crush',
    since: engine.now(),
    crushFrom: [a!],
    dates: [],
    updatedAt: engine.now(),
  };
  engine.upsertRomance(romance);
  engine.upsertRomance({ ...romance, stage: 'dating', crushFrom: [a!, b!], updatedAt: engine.now() });
  await engine.advance(2 * 24 * 60, { step: 1 });
  return { engine, a: a!, b: b! };
}

describe('observer API v2 (spec v2 §17)', () => {
  it('serves letters, notices, the Keep and animals with their filters', async () => {
    const { engine, a } = await busyWorld();
    const { list } = await boot(engine);

    const letters = await list('/api/letters?limit=1000');
    const mine = letters.find((l) => l.text === LETTER)!;
    expect(mine).toMatchObject({ from: PLAYER_ID, to: a, reply: 'Yes please, I love penguins!' });
    for (const l of letters) {
      expect(Date.parse(l.ts)).not.toBeNaN();
      expect(l.time).toMatch(/^\d{2}:\d{2}$/);
      expect(typeof l.day).toBe('number');
      expect(['posted', 'delivered', 'read', 'replied', 'returned']).toContain(l.status);
    }
    expect((await list(`/api/letters?agent=${a}`)).every((l) => l.from === a || l.to === a)).toBe(true);
    expect(await list('/api/letters?limit=1')).toHaveLength(1);
    expect(await list(`/api/letters?since=${engine.now() + 1}`)).toEqual([]);

    const notices = await list('/api/notices');
    const active = engine.playerWorld.snapshot().notices.filter((n) => n.expiresAt > engine.now());
    expect(notices.map((n) => n.id)).toEqual(active.map((n) => n.id));

    const keep = await list('/api/keep?limit=1000');
    expect(keep.length).toBe(engine.playerWorld.post.keep.size());
    expect((await list('/api/keep?kind=letter')).every((e) => e.kind === 'letter')).toBe(true);
    const found = await list('/api/keep?q=PENGUINS');
    expect(found.length).toBeGreaterThanOrEqual(1);
    expect(found.every((e) => /penguins/i.test(e.text))).toBe(true);
    expect(await list('/api/keep?limit=2')).toHaveLength(Math.min(2, keep.length));

    const animals = await list('/api/animals');
    expect(animals).toHaveLength(engine.animals.all().length);
    for (const x of animals) {
      for (const k of ['id', 'species', 'group', 'location', 'status']) expect(typeof x[k], k).toBe('string');
      expect(typeof x.x).toBe('number');
    }
    const farm = await list('/api/animals?group=farm');
    expect(farm.length).toBeGreaterThan(0);
    expect(farm.every((x) => x.group === 'farm' && typeof x.stage === 'string')).toBe(true);
    const species = farm[0]!.species as string;
    expect((await list(`/api/animals?species=${species}`)).every((x) => x.species === species)).toBe(true);
  });

  it('rejects unknown filter values with 400', async () => {
    const { engine } = createSimTestWorld({ startAt: '06:00' });
    const { get } = await boot(engine);
    expect((await get('/api/keep?kind=diary')).res.status).toBe(400);
    expect((await get('/api/animals?group=pets')).res.status).toBe(400);
    expect((await get('/api/letters?limit=0')).res.status).toBe(400);
    expect((await get('/api/events?type=dragon')).res.status).toBe(400);
    for (const t of TOWN_EVENT_TYPES) expect((await get(`/api/events?type=${t}`)).res.status, t).toBe(200);
  });

  it('logs the v2 event types and shows romance kinds, state fields and agent kinds', async () => {
    const { engine, a, b } = await busyWorld();
    const { get, list } = await boot(engine);
    const types = new Set((await list('/api/events?limit=1000')).map((e) => e.type));
    for (const t of ['letter_sent', 'letter_replied', 'notice_posted', 'keep_logged', 'crush', 'romance'])
      expect(types, t).toContain(t);
    for (const t of ['train_arrived', 'train_departed', 'visitor_arrived', 'animal_born'])
      expect(types, t).toContain(t);
    for (const t of types) expect(TOWN_EVENT_TYPES as readonly string[]).toContain(t);

    const { body: state } = await get('/api/state');
    for (const k of ['train', 'hotel', 'visitors', 'farm', 'stock']) expect(state, k).toHaveProperty(k);
    expect(state!.player.kind).toBe('player');
    const visitorIds = new Set(engine.playerWorld.snapshot().visitors.map((v) => v.villagerId));
    for (const ag of state!.agents as Json[]) {
      const p = engine.profile(ag.id)!;
      expect(ag.kind).toBe(p.visitor ? 'visitor' : p.transient ? 'stranger' : 'villager');
      if (visitorIds.has(ag.id)) expect(ag.kind).toBe('visitor');
    }

    const { body: agent } = await get(`/api/agents/${a}`);
    expect(agent!.romance).toMatchObject({ stage: 'dating', partner: b });
    expect((agent!.relationships as Json[]).find((r) => r.with === b)?.kind).toBe('dating');
    const { body: laude } = await get('/api/agents/laude');
    expect((laude!.relationships as Json[]).find((r) => r.with === 'franzi')?.kind).toBe('shy_crush');
    const visitor = [...visitorIds].find((id) => engine.profile(id));
    expect(visitor, 'a visitor in town').toBeDefined();
    expect((await get(`/api/agents/${visitor}`)).body!.visitor).toMatchObject({ status: expect.any(String) });
  });

  it('stays read-only over real HTTP: 405 for writes, and a full crawl changes nothing', async () => {
    const { engine } = await busyWorld();
    const { base, get } = await boot(engine);
    const v2 = ['/api/letters', '/api/notices', '/api/keep', '/api/animals'];
    for (const path of v2) {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const res = await fetch(`${base}${path}`, { method, body: method === 'DELETE' ? null : '{}' });
        expect(res.status, `${method} ${path}`).toBe(405);
        expect(res.headers.get('allow')).toBe('GET, HEAD');
      }
      expect((await fetch(`${base}${path}`, { method: 'HEAD' })).status).toBe(200);
    }
    const strip = (s: ReturnType<Engine['toSaveData']>) =>
      JSON.stringify({ ...s, savedAt: '', observer: { log: s.observer?.log } });
    const snapshot = JSON.stringify(engine.snapshot());
    const save = strip(engine.toSaveData());
    const q0 = engine.queue.stats();
    const paths = [
      '/api/state',
      '/api/events?limit=1000',
      '/api/conversations',
      '/api/notes',
      '/api/stats',
      ...v2,
      '/api/letters?limit=1000&agent=mia',
      '/api/keep?limit=1000&kind=letter&q=penguins',
      '/api/animals?group=zoo',
      ...engine.villagerIds().flatMap((id) => [`/api/agents/${id}`, `/api/agents/${id}/memories?limit=500`]),
    ];
    for (let i = 0; i < 2; i++) for (const p of paths) expect((await get(p)).res.status, p).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    const q1 = engine.queue.stats();
    expect(q1.done + q1.failed + q1.queued + q1.running).toBe(q0.done + q0.failed + q0.queued + q0.running);
    expect(JSON.stringify(engine.snapshot())).toBe(snapshot);
    expect(strip(engine.toSaveData())).toBe(save);
  });
});
