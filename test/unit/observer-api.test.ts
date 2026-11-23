import { networkInterfaces } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { createMind, type Mind } from '../../src/server/cognition/mind.ts';
import { MockChatProvider } from '../../src/server/llm/providers/mock.ts';
import { checkAccess, isLoopback } from '../../src/server/net/observer.ts';
import { decodePng } from '../../src/server/net/screenshot.ts';
import { startServer, type RunningServer } from '../../src/server/net/server.ts';
import { createSimEngine, type Engine } from '../../src/server/sim/engine.ts';
import { TownLog } from '../../src/server/sim/town-log.ts';
import { createStubMind } from '../../src/server/sim/stub-mind.ts';
import type { PartialConfig } from '../../src/server/config.ts';
import { at } from '../../src/shared/time.ts';
import { createSimTestWorld, testConfig } from '../helpers/sim.ts';

type Json = Record<string, unknown> & Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const running: { server: RunningServer; engine: Engine }[] = [];

afterEach(async () => {
  for (const r of running.splice(0)) {
    r.engine.stop();
    await r.server.close();
  }
});

async function boot(opts: { config?: PartialConfig; engine?: Engine; host?: string; startAt?: string } = {}) {
  const engine =
    opts.engine ?? createSimTestWorld({ startAt: opts.startAt ?? '06:00', config: opts.config ?? {} }).engine;
  const server = await startServer({
    host: opts.host ?? '127.0.0.1',
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
  return { engine, server, base, get };
}

const ENDPOINTS = [
  '/api/state',
  '/api/agents/mia',
  '/api/agents/mia/memories',
  '/api/conversations',
  '/api/notes',
  '/api/events',
  '/api/stats',
  '/api/screenshot',
];

describe('observer API: endpoints', () => {
  it('GET /api/state summarises the town', async () => {
    const { get, engine } = await boot({ startAt: '10:00' });
    const { res, body } = await get('/api/state');
    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      day: 1,
      time: '10:00',
      paused: false,
      speed: 1,
      weather: 'clear',
      event_active: null,
    });
    expect(body!.tick).toBe(engine.now());
    expect(Date.parse(body!.ts)).not.toBeNaN();
    expect(body!.agents).toHaveLength(engine.villagerIds().length);
    const a = body!.agents[0];
    expect(Object.keys(a)).toEqual(
      expect.arrayContaining([
        'id',
        'name',
        'location',
        'x',
        'y',
        'activity',
        'current_thought',
        'mood',
        'needs',
        'kind',
      ]),
    );
    expect(a.kind).toBe('villager');
    for (const k of ['hunger', 'energy', 'social', 'fun']) {
      expect(Number.isInteger(a.needs[k])).toBe(true);
      expect(a.needs[k]).toBeGreaterThanOrEqual(0);
      expect(a.needs[k]).toBeLessThanOrEqual(100);
    }
    expect(body!.agents.some((x: Json) => x.id === 'player')).toBe(false);
    expect(body!.player).toMatchObject({ id: 'player' });
    engine.setSpeed(0);
    expect((await get('/api/state')).body).toMatchObject({ paused: true, speed: 0 });
  });

  it("GET /api/agents/{id} has bio, home, relationships and today's plan; unknown ids are 404", async () => {
    const { get, engine } = await boot();
    await engine.advance(60, { drainLlm: true });
    const id = engine.villagerIds()[0]!;
    const { res, body } = await get(`/api/agents/${id}`);
    expect(res.status).toBe(200);
    const profile = engine.profile(id)!;
    expect(body).toMatchObject({ id, name: profile.name, bio: profile.bio, home: profile.homeId });
    expect(Array.isArray(body!.relationships)).toBe(true);
    for (const r of body!.relationships) {
      expect(r).toEqual(
        expect.objectContaining({
          with: expect.any(String),
          kind: expect.any(String),
          score: expect.any(Number),
        }),
      );
      expect(r).toHaveProperty('note');
    }
    expect(body!.plan_today.length).toBeGreaterThan(0);
    for (const b of body!.plan_today) {
      expect(b.time).toMatch(/^\d{2}:\d{2}$/);
      expect(typeof b.text).toBe('string');
      expect(typeof b.done).toBe('boolean');
    }
    expect(body).toHaveProperty('current_thought');
    expect((await get('/api/agents/nobody')).res.status).toBe(404);
    expect((await get('/api/agents/nobody/memories')).res.status).toBe(404);
    const player = await get('/api/agents/player');
    expect(player.res.status).toBe(200);
    expect(player.body).toMatchObject({ id: 'player', kind: 'player', inside: null, relationships: [] });
    expect((await get('/api/agents/player/memories')).res.status).toBe(404);
  });

  it('GET /api/agents/{id}/memories is newest first with limit, kind and since filters', async () => {
    const { get, engine } = await boot();
    const id = engine.villagerIds()[0]!;
    await engine.advance(30, { drainLlm: true });
    const mark = engine.now();
    engine.handleCommand({
      type: 'debug.inject',
      villagerId: id,
      text: 'The well is haunted',
      importance: 7,
    });
    await engine.advance(30, { drainLlm: true });
    const all = (await get(`/api/agents/${id}/memories?limit=500`)).body as unknown as Json[];
    expect(all.length).toBeGreaterThan(1);
    for (let i = 1; i < all.length; i++) expect(all[i - 1]!.tick).toBeGreaterThanOrEqual(all[i]!.tick);
    for (const m of all) {
      expect(Object.keys(m)).toEqual(
        expect.arrayContaining(['ts', 'day', 'time', 'kind', 'importance', 'text']),
      );
      expect(['observation', 'reflection', 'plan', 'chat', 'note']).toContain(m.kind);
    }
    expect(((await get(`/api/agents/${id}/memories?limit=2`)).body as unknown as Json[]).length).toBe(2);
    const chat = (await get(`/api/agents/${id}/memories?kind=chat`)).body as unknown as Json[];
    expect(chat.some((m) => m.text.includes('haunted'))).toBe(true);
    expect(chat.every((m) => m.kind === 'chat')).toBe(true);
    const since = mark - 0.5;
    const newer = (await get(`/api/agents/${id}/memories?since=${since}`)).body as unknown as Json[];
    expect(newer.some((m) => m.text.includes('haunted'))).toBe(true);
    expect(newer.every((m) => m.tick > since)).toBe(true);
    expect(newer.length).toBeLessThan(all.length);
    expect((await get(`/api/agents/${id}/memories?kind=dream`)).res.status).toBe(400);
    expect((await get(`/api/agents/${id}/memories?limit=0`)).res.status).toBe(400);
  });

  it('GET /api/conversations returns transcripts with per-line speakers; since and agent filter', async () => {
    const { get, engine } = await boot();
    for (let i = 0; i < 16 && engine.conversations().filter((c) => c.status !== 'active').length < 2; i++)
      await engine.advance(30, { drainLlm: true });
    const list = (await get('/api/conversations')).body as unknown as Json[];
    expect(list.length).toBeGreaterThan(0);
    const c = list[0]!;
    expect(Object.keys(c)).toEqual(expect.arrayContaining(['id', 'ts', 'location', 'participants', 'lines']));
    expect(c.lines.length).toBeGreaterThan(0);
    for (const l of c.lines) {
      expect(l).toEqual(
        expect.objectContaining({
          speaker: expect.any(String),
          speaker_id: expect.any(String),
          text: expect.any(String),
          day: 1,
        }),
      );
      expect(c.participants).toContain(l.speaker_id);
      expect(l.time).toMatch(/^\d{2}:\d{2}$/);
    }
    const who = c.participants[0];
    const mine = (await get(`/api/conversations?agent=${who}`)).body as unknown as Json[];
    expect(mine.every((x) => x.participants.includes(who))).toBe(true);
    const lastTick = list.at(-1)!.updated_tick as number;
    expect(((await get(`/api/conversations?since=${lastTick}`)).body as unknown as Json[]).length).toBe(0);
    expect(((await get('/api/conversations?limit=1')).body as unknown as Json[]).length).toBe(1);
  });

  it('GET /api/notes lists door notes; GET /api/events logs note_left', async () => {
    const { get, engine } = await boot({ startAt: '10:00' });
    const owner = engine.villagerIds()[0]!;
    const house = engine.profile(owner)!.homeId;
    engine.handleCommand({ type: 'note.post', houseId: house, text: 'Your bike is in my shed' });
    const notes = (await get(`/api/notes?agent=${owner}`)).body as unknown as Json[];
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      from: 'player',
      to: owner,
      text: 'Your bike is in my shed',
      read: false,
    });
    expect(Date.parse(notes[0]!.ts)).not.toBeNaN();
    expect(((await get('/api/notes?agent=someone_else')).body as unknown as Json[]).length).toBe(0);
    const events = (await get('/api/events?type=note_left')).body as unknown as Json[];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'note_left', agents: ['player', owner] });
  });

  it('GET /api/events: town log with types, since=<tick>, since=<iso> via x-next-since, limit', async () => {
    const { get, engine } = await boot();
    await engine.advance(240, { drainLlm: true });
    const all = (await get('/api/events?limit=1000')).body as unknown as Json[];
    const types = new Set(all.map((e) => e.type));
    expect(types).toContain('move');
    expect(types).toContain('plan_change');
    for (const e of all) {
      expect(Object.keys(e)).toEqual(expect.arrayContaining(['ts', 'day', 'time', 'type', 'agents', 'text']));
      expect(e.agents.length).toBeGreaterThan(0);
    }
    for (let i = 1; i < all.length; i++)
      expect(Date.parse(all[i]!.ts)).toBeGreaterThan(Date.parse(all[i - 1]!.ts));
    // Polling by ISO timestamp pages through everything exactly once.
    const seen: number[] = [];
    let since = '';
    for (let i = 0; i < 1000; i++) {
      const { res, body } = await get(
        `/api/events?limit=7${since ? `&since=${encodeURIComponent(since)}` : '&since=0'}`,
      );
      const page = body as unknown as Json[];
      if (page.length === 0) break;
      seen.push(...page.map((e) => e.seq));
      since = res.headers.get('x-next-since')!;
      expect(since).toBe(page.at(-1)!.ts);
    }
    expect(seen).toEqual(all.map((e) => e.seq));
    const mid = all[Math.floor(all.length / 2)]!;
    const after = (await get(`/api/events?since=${mid.tick}&limit=1000`)).body as unknown as Json[];
    expect(after.every((e) => e.tick > mid.tick)).toBe(true);
    expect(((await get('/api/events?limit=3')).body as unknown as Json[]).map((e) => e.seq)).toEqual(
      all.slice(-3).map((e) => e.seq),
    );
    expect(
      ((await get('/api/events?type=move')).body as unknown as Json[]).every((e) => e.type === 'move'),
    ).toBe(true);
    expect((await get('/api/events?since=yesterday-ish')).res.status).toBe(400);
    expect((await get('/api/events?type=explosion')).res.status).toBe(400);
  });

  it('GET /api/stats shows model and queue numbers but no secrets', async () => {
    const { get } = await boot({ config: { llm: { apiKey: 'sk-very-secret' }, observer: { token: '' } } });
    const { body } = await get('/api/stats');
    expect(body).toMatchObject({
      model: 'mock-model',
      calls: expect.any(Number),
      failed: expect.any(Number),
      queue_len: expect.any(Number),
    });
    expect(body).toHaveProperty('avg_latency_ms');
    for (const p of ENDPOINTS.filter((e) => e !== '/api/screenshot')) {
      const raw = await (await fetch(`${running[0]!.server.url}${p}`)).text();
      expect(raw).not.toContain('sk-very-secret');
    }
  });

  it('GET /api/screenshot renders the map as a PNG', async () => {
    const { base, engine } = await boot({ startAt: '10:00' });
    const res = await fetch(`${base}/api/screenshot`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const img = decodePng(new Uint8Array(await res.arrayBuffer()));
    expect(img.width).toBe(engine.map.width * engine.map.tileSize);
    expect(img.height).toBe(engine.map.height * engine.map.tileSize);
    const opaque = img.data.filter((_, i) => i % 4 === 3 && img.data[i] === 255).length;
    expect(opaque).toBe(img.width * img.height);
    const big = decodePng(
      new Uint8Array(await (await fetch(`${base}/api/screenshot?scale=2`)).arrayBuffer()),
    );
    expect(big.width).toBe(img.width * 2);
    expect((await fetch(`${base}/api/screenshot?scale=9`)).status).toBe(400);
  });
});

describe('observer API: read-only', () => {
  it('rejects every non-GET/HEAD method with 405 on all observer paths', async () => {
    const { base } = await boot();
    for (const path of ENDPOINTS) {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const res = await fetch(`${base}${path}`, { method, body: method === 'DELETE' ? null : '{}' });
        expect(res.status, `${method} ${path}`).toBe(405);
        expect(res.headers.get('allow')).toBe('GET, HEAD');
      }
      const head = await fetch(`${base}${path}`, { method: 'HEAD' });
      expect(head.status, `HEAD ${path}`).toBe(200);
    }
    expect((await fetch(`${base}/api/nope`)).status).toBe(404);
    expect((await fetch(`${base}/api/snapshot`, { method: 'POST' })).status).toBe(405);
  });

  it('polling every endpoint starts no LLM work and changes no sim state', async () => {
    const engine = createSimEngine({
      config: testConfig({ cognition: { importanceMode: 'heuristic' } }),
      providers: { chat: new MockChatProvider(), embeddings: null },
      createMind,
      startAt: at(0, '06:00'),
    });
    await engine.advance(120, { drainLlm: true });
    const { get } = await boot({ engine });
    const id = engine.villagerIds()[0]!;
    const before = engine.queue.stats();
    const strip = (s: ReturnType<Engine['toSaveData']>) =>
      JSON.stringify({ ...s, savedAt: '', observer: { log: s.observer?.log } });
    const state = strip(engine.toSaveData());
    for (let i = 0; i < 3; i++) {
      for (const p of [
        ...ENDPOINTS,
        `/api/agents/${id}`,
        `/api/agents/${id}/memories?limit=500`,
        '/api/snapshot',
      ]) {
        expect((await get(p)).res.status, p).toBe(200);
      }
    }
    await new Promise((r) => setTimeout(r, 50));
    const after = engine.queue.stats();
    expect(after.done + after.failed + after.queued + after.running).toBe(
      before.done + before.failed + before.queued + before.running,
    );
    expect(strip(engine.toSaveData())).toBe(state);
  });
});

describe('observer API: access control', () => {
  it('requires the bearer token on every observer request when one is set', async () => {
    const { base, server } = await boot({ config: { observer: { token: 'tok-123' } } });
    for (const path of ENDPOINTS) {
      const none = await fetch(`${base}${path}`);
      expect(none.status, path).toBe(401);
      expect(none.headers.get('www-authenticate')).toBe('Bearer');
      expect((await fetch(`${base}${path}`, { headers: { authorization: 'Bearer nope' } })).status).toBe(401);
      expect((await fetch(`${base}${path}`, { headers: { authorization: 'Bearer tok-123' } })).status).toBe(
        200,
      );
    }
    expect((await fetch(`${server.url}/api/health`)).status).toBe(200);
  });

  it('loopback check and remote rules', () => {
    for (const a of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) expect(isLoopback(a)).toBe(true);
    for (const a of ['10.0.0.5', '192.168.1.2', '::ffff:10.0.0.1', 'fe80::1', undefined])
      expect(isLoopback(a)).toBe(false);
    const remote = { remoteAddress: '10.0.0.5', authorization: 'Bearer t' };
    expect(checkAccess(remote, { allowRemote: false, token: 't' })).toMatchObject({ ok: false, status: 403 });
    expect(checkAccess(remote, { allowRemote: true, token: '' })).toMatchObject({ ok: false, status: 403 });
    expect(checkAccess(remote, { allowRemote: true, token: 't' })).toEqual({ ok: true });
    expect(
      checkAccess({ ...remote, authorization: 'Bearer x' }, { allowRemote: true, token: 't' }),
    ).toMatchObject({ status: 401 });
    expect(
      checkAccess(
        { remoteAddress: '127.0.0.1', authorization: undefined },
        { allowRemote: false, token: '' },
      ),
    ).toEqual({ ok: true });
  });

  const lanIp = Object.values(networkInterfaces())
    .flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;

  it.skipIf(!lanIp)(
    'rejects non-loopback clients when the game server listens on all interfaces',
    async () => {
      const { server } = await boot({ host: '0.0.0.0' });
      const viaLan = `http://${lanIp}:${server.port}`;
      expect((await fetch(`${viaLan}/api/state`)).status).toBe(403);
      expect((await fetch(`${viaLan}/api/health`)).status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${server.port}/api/state`)).status).toBe(200);
    },
  );

  it.skipIf(!lanIp)('accepts remote clients only with allowRemote and the token', async () => {
    const { server } = await boot({
      host: '0.0.0.0',
      config: { observer: { allowRemote: true, token: 'lan-token' } },
    });
    const viaLan = `http://${lanIp}:${server.port}`;
    expect((await fetch(`${viaLan}/api/state`)).status).toBe(401);
    expect(
      (await fetch(`${viaLan}/api/state`, { headers: { authorization: 'Bearer lan-token' } })).status,
    ).toBe(200);
  });

  it('serves the API on a separate listener when observer.port is set, and nowhere when disabled', async () => {
    const { server, get } = await boot({ config: { observer: { port: 0 } } });
    expect(server.observerUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(server.observerUrl).not.toBe(server.url);
    expect((await get('/api/state')).res.status).toBe(200);
    expect((await fetch(`${server.url}/api/state`)).status).toBe(404);
    expect((await get('/api/health')).res.status).toBe(404);
    const off = await boot({ config: { observer: { enabled: false } } });
    expect((await off.get('/api/state')).res.status).toBe(404);
    expect((await off.get('/api/snapshot')).res.status).toBe(200);
  });
});

describe('town log', () => {
  it('records new reflections of LLM minds', async () => {
    const engine = createSimEngine({
      config: testConfig({ cognition: { importanceMode: 'heuristic' } }),
      providers: { chat: new MockChatProvider(), embeddings: null },
      createMind,
      startAt: at(0, '09:00'),
    });
    const id = engine.villagerIds()[0]!;
    await engine.advance(5, { drainLlm: true });
    (engine.mind(id) as Mind).memory.add({
      kind: 'reflection',
      at: engine.now(),
      text: 'I think the bakery is the heart of the village',
      importance: 7,
    });
    await engine.advance(3, { drainLlm: true });
    const hits = engine.townLog.list().filter((e) => e.type === 'reflection' && e.agents[0] === id);
    expect(hits.map((e) => e.text)).toEqual([expect.stringContaining('the heart of the village')]);
  });

  it('survives a save and reload', async () => {
    const { engine } = createSimTestWorld({ startAt: '06:00' });
    await engine.advance(120, { drainLlm: true });
    const before = engine.townLog.list().map((e) => e.seq);
    expect(before.length).toBeGreaterThan(0);
    const save = JSON.parse(JSON.stringify(engine.toSaveData()));
    const resumed = createSimEngine({
      config: engine.config,
      providers: { chat: new MockChatProvider(), embeddings: null },
      createMind: createStubMind,
      restore: save,
    });
    expect(resumed.townLog.list().map((e) => e.seq)).toEqual(before);
    const ts = resumed.townLog.tsOf(at(0, '07:00'));
    expect(ts).toBe(engine.townLog.tsOf(at(0, '07:00')));
    await resumed.advance(120, { drainLlm: true });
    const next = resumed.townLog.list();
    expect(next.at(-1)!.seq).toBeGreaterThan(before.at(-1)!);
  });

  it('is a bounded ring buffer with strictly increasing timestamps', () => {
    const log = new TownLog({ size: 100, now: () => 0, realMsPerGameMinute: 625, clockMs: () => 1_000 });
    for (let i = 0; i < 150; i++) log.add('move', ['a'], `step ${i}`);
    const list = log.list();
    expect(list).toHaveLength(100);
    expect(list[0]!.text).toBe('step 50');
    for (let i = 1; i < list.length; i++)
      expect(Date.parse(list[i]!.ts)).toBeGreaterThan(Date.parse(list[i - 1]!.ts));
  });

  it('maps game time to real time through the anchors', () => {
    let ms = 1_000_000;
    let game = 360;
    const log = new TownLog({ size: 100, now: () => game, realMsPerGameMinute: 625, clockMs: () => ms });
    log.anchor(true);
    ms += 10_000;
    game += 10;
    log.anchor();
    ms += 60_000; // paused for a minute, then restarted
    log.anchor(true);
    ms += 5_000;
    game += 10;
    expect(log.msOf(360)).toBe(1_000_000);
    expect(log.msOf(365)).toBe(1_005_000);
    expect(log.msOf(370)).toBe(1_010_000);
    expect(log.msOf(375)).toBe(1_072_500);
    expect(log.msOf(380)).toBe(ms);
    expect(log.msOf(350)).toBe(1_000_000 - 10 * 625);
  });
});
