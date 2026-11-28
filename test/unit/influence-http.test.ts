/** TASK-18 I2: influence HTTP contract — status order, token, body limits, log paging (spec §3, §4.6, AC1-AC4). */
import { createServer, request, type IncomingHttpHeaders } from 'node:http';
import { connect as connectTcp, type AddressInfo, type Socket } from 'node:net';
import { networkInterfaces } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PartialConfig } from '../../src/server/config.ts';
import {
  createInfluenceApi,
  parseInfluenceBody,
  type InfluenceSource,
} from '../../src/server/net/influence.ts';
import { checkAccess, tokenMatches } from '../../src/server/net/observer.ts';
import { startServer } from '../../src/server/net/server.ts';
import type { InfluenceHandler } from '../../src/server/sim/influence.ts';
import type { InfluenceRequest, InfluenceResult } from '../../src/shared/influence.ts';
import { createSimTestWorld } from '../helpers/sim.ts';

const TOKEN = 'influence-test-token-0123456789abcdef';
const AUTH = { authorization: `Bearer ${TOKEN}` };
const JSON_AUTH = { ...AUTH, 'content-type': 'application/json' };
const ENDPOINTS = ['rumour', 'note', 'event', 'nudge', 'weather'];

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  vi.restoreAllMocks();
});

const accepting: InfluenceHandler<'weather'> = {
  check: () => ({
    targets: [],
    text: 'The sky clouded over',
    outcomes: { swaps: 0 },
    apply: () => ({ refs: {} }),
  }),
};

async function boot(
  opts: {
    config?: PartialConfig;
    host?: string;
    source?: InfluenceSource;
    bodyTimeoutMs?: number;
  } = {},
) {
  const { engine } = createSimTestWorld({
    config: { ...opts.config, influence: { enabled: true, token: TOKEN, ...opts.config?.influence } },
  });
  engine.influence.register('weather', accepting);
  const server = await startServer({
    host: opts.host ?? '127.0.0.1',
    port: 0,
    staticDir: 'dist/client',
    debug: false,
    llm: { provider: 'mock', model: 'mock-model', embeddings: null },
    engine,
    observer: { config: engine.config.observer, source: engine },
    influence: {
      config: engine.config.influence,
      ...(opts.source ? { source: opts.source } : {}),
      ...(opts.bodyTimeoutMs ? { bodyTimeoutMs: opts.bodyTimeoutMs } : {}),
    },
  });
  closers.push(() => server.close());
  return { engine, server };
}

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
  json: () => unknown;
}

/**
 * Raw request: explicit headers, and the body is written as given (a string, or a number of bytes
 * streamed in 64 KiB chunks). Resolves on the response, even if the server then drops the socket.
 */
function call(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string | { bytes: number; end?: boolean },
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let raw = '';
      res.on('data', (c: Buffer) => (raw += c));
      const done = () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: raw,
          json: () => JSON.parse(raw),
        });
      res.on('end', done);
      res.on('error', done);
      res.on('aborted', done);
    });
    req.on('error', (err) => {
      if (!req.destroyed || !('code' in err)) reject(err);
    });
    if (typeof body === 'string') req.end(body);
    else if (body) {
      const chunk = Buffer.alloc(64 * 1024, 'a');
      let left = body.bytes;
      const pump = () => {
        while (left > 0) {
          const n = Math.min(left, chunk.length);
          left -= n;
          if (!req.write(chunk.subarray(0, n))) return void req.once('drain', pump);
        }
        if (body.end !== false) req.end();
      };
      req.on('error', () => (left = 0));
      pump();
    } else req.end();
  });
}

const post = (port: number, endpoint: string, body: unknown, headers: Record<string, string> = JSON_AUTH) =>
  call(port, 'POST', `/api/influence/${endpoint}`, headers, JSON.stringify(body));

function noCors(r: Reply): void {
  expect(Object.keys(r.headers).filter((h) => h.startsWith('access-control-'))).toEqual([]);
}

describe('influence API disabled (AC1)', () => {
  it('answers 404 for every method on every influence path, the log included', async () => {
    const { engine } = createSimTestWorld();
    expect(engine.config.influence.enabled).toBe(false);
    const server = await startServer({
      host: '127.0.0.1',
      port: 0,
      staticDir: 'dist/client',
      debug: false,
      llm: { provider: 'mock', model: 'mock-model', embeddings: null },
      engine,
      influence: { config: engine.config.influence },
    });
    closers.push(() => server.close());
    const paths = ['/api/influence', '/api/influence/', '/api/influence/log', '/api/influence/x/y'];
    for (const e of ENDPOINTS) paths.push(`/api/influence/${e}`, `/api/influence/${e}/`);
    for (const path of paths)
      for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH']) {
        const r = await call(
          server.port,
          method,
          path,
          JSON_AUTH,
          method === 'GET' || method === 'HEAD' ? undefined : '{}',
        );
        expect(r.status, `${method} ${path}`).toBe(404);
        noCors(r);
      }
  });

  it('is 404 too when the server gets no influence config at all (default off)', async () => {
    const { engine } = createSimTestWorld({ config: { influence: { enabled: true, token: TOKEN } } });
    const server = await startServer({
      host: '127.0.0.1',
      port: 0,
      staticDir: 'dist/client',
      debug: false,
      llm: { provider: 'mock', model: 'mock-model', embeddings: null },
      engine,
    });
    closers.push(() => server.close());
    expect((await post(server.port, 'weather', { weather: 'clear' })).status).toBe(404);
  });

  it('the engine refuses influences while the API is off (defence in depth)', () => {
    const { engine } = createSimTestWorld();
    engine.influence.register('weather', accepting);
    const r = engine.applyInfluence({ endpoint: 'weather', body: { weather: 'clear' } });
    expect(r).toMatchObject({ ok: false, status: 422, error: 'invalid' });
    expect(engine.influenceLog({}).entries).toEqual([]);
  });
});

describe('influence API status order (AC3, AC4)', () => {
  it('is routed before the generic 405 guard and accepts a valid POST', async () => {
    const { server, engine } = await boot();
    const r = await post(server.port, 'weather', { weather: 'rain', hours: 2 });
    expect(r.status).toBe(200);
    expect(r.json()).toEqual({ id: 'inf_1', tick: engine.now(), refs: {} });
    expect(r.headers['cache-control']).toBe('no-store');
    noCors(r);
  });

  it('405 with Allow for a wrong method, before the token is checked', async () => {
    const { server } = await boot();
    for (const e of ENDPOINTS) {
      const r = await call(server.port, 'GET', `/api/influence/${e}`);
      expect(r.status, e).toBe(405);
      expect(r.headers.allow).toBe('POST');
    }
    for (const m of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
      const r = await call(server.port, m, '/api/influence/log', {}, '{}');
      expect(r.status, m).toBe(405);
      expect(r.headers.allow).toBe('GET, HEAD');
      noCors(r);
    }
  });

  it('404 for an unknown influence path while enabled', async () => {
    const { server } = await boot();
    expect((await call(server.port, 'POST', '/api/influence/storm', JSON_AUTH, '{}')).status).toBe(404);
    expect((await call(server.port, 'GET', '/api/influence', AUTH)).status).toBe(404);
  });

  it('403 for a foreign Host header (TASK-17)', async () => {
    const { server } = await boot();
    const r = await call(
      server.port,
      'POST',
      '/api/influence/weather',
      { ...JSON_AUTH, host: 'evil.example:80' },
      '{}',
    );
    expect(r.status).toBe(403);
  });

  it('403 for a non-loopback client, even with the right token', async () => {
    const source: InfluenceSource = {
      applyInfluence: vi.fn(),
      influenceLog: vi.fn(),
    };
    const api = createInfluenceApi({
      config: { enabled: true, token: TOKEN, perGameDay: 6, logMax: 500 },
      source,
    });
    const http = createServer((req, res) => {
      Object.defineProperty(req.socket, 'remoteAddress', { value: '192.168.1.7', configurable: true });
      if (!api.handle(req, res, new URL(req.url ?? '/', 'http://localhost'))) res.end();
    });
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
    closers.push(() => new Promise((r) => http.close(() => r())));
    const port = (http.address() as AddressInfo).port;
    const r = await call(port, 'POST', '/api/influence/weather', JSON_AUTH, '{"weather":"clear"}');
    expect(r.status).toBe(403);
    expect((await call(port, 'GET', '/api/influence/log', AUTH)).status).toBe(403);
    expect(source.applyInfluence).not.toHaveBeenCalled();
  });

  const lanIp = Object.values(networkInterfaces())
    .flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
  it.skipIf(!lanIp)('403 over a LAN address when the server listens on all interfaces', async () => {
    const { server } = await boot({ host: '0.0.0.0' });
    const r = await fetch(`http://${lanIp}:${server.port}/api/influence/log`, { headers: AUTH });
    expect(r.status).toBe(403);
  });

  it('401 for a missing, wrong or non-Bearer token', async () => {
    const { server } = await boot();
    const body = '{"weather":"clear"}';
    const ct = { 'content-type': 'application/json' };
    for (const auth of [undefined, `Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(1)}`, `Basic ${TOKEN}`, TOKEN]) {
      const r = await call(
        server.port,
        'POST',
        '/api/influence/weather',
        auth ? { ...ct, authorization: auth } : ct,
        body,
      );
      expect(r.status, String(auth)).toBe(401);
      expect(r.headers['www-authenticate']).toBe('Bearer');
      noCors(r);
    }
    expect((await call(server.port, 'GET', '/api/influence/log')).status).toBe(401);
  });

  it('401 before the body is read: a 10 MiB body with a bad token gets 401, not 413', async () => {
    const { server } = await boot();
    const r = await call(
      server.port,
      'POST',
      '/api/influence/weather',
      {
        'content-type': 'application/json',
        authorization: 'Bearer wrong',
        'content-length': String(10 * 1024 * 1024),
      },
      { bytes: 10 * 1024 * 1024 },
    );
    expect(r.status).toBe(401);
    // Same without a Content-Length (chunked): the server never waits for the body.
    const chunked = await call(
      server.port,
      'POST',
      '/api/influence/weather',
      { 'content-type': 'application/json', authorization: 'Bearer wrong' },
      { bytes: 10 * 1024 * 1024, end: false },
    );
    expect(chunked.status).toBe(401);
  });

  it('415 unless the Content-Type is application/json', async () => {
    const { server } = await boot();
    for (const ct of [undefined, 'text/plain', 'application/jsonx', 'multipart/form-data']) {
      const r = await call(
        server.port,
        'POST',
        '/api/influence/weather',
        ct ? { ...AUTH, 'content-type': ct } : AUTH,
        '{"weather":"clear"}',
      );
      expect(r.status, String(ct)).toBe(415);
    }
    const withCharset = await call(
      server.port,
      'POST',
      '/api/influence/weather',
      { ...AUTH, 'content-type': 'Application/JSON; charset=utf-8' },
      '{"weather":"rain","hours":1}',
    );
    expect(withCharset.status).toBe(200);
  });

  it('413 for a body over 4 KiB, by Content-Length or as it streams', async () => {
    const { server } = await boot();
    const big = await call(
      server.port,
      'POST',
      '/api/influence/weather',
      { ...JSON_AUTH, 'content-length': '5000' },
      {
        bytes: 5000,
      },
    );
    expect(big.status).toBe(413);
    const streamed = await call(server.port, 'POST', '/api/influence/weather', JSON_AUTH, {
      bytes: 64 * 1024,
      end: false,
    });
    expect(streamed.status).toBe(413);
    const atLimit = JSON.stringify({ weather: 'clear', hours: 1 }).padEnd(4096, ' ');
    expect((await call(server.port, 'POST', '/api/influence/weather', JSON_AUTH, atLimit)).status).toBe(200);
  });

  it('408 when the body does not arrive in time', async () => {
    const { server } = await boot({ bodyTimeoutMs: 150 });
    const r = await call(
      server.port,
      'POST',
      '/api/influence/weather',
      { ...JSON_AUTH, 'content-length': '100' },
      {
        bytes: 10,
        end: false,
      },
    );
    expect(r.status).toBe(408);
  });

  it('400 for bad JSON, unknown fields and values out of range', async () => {
    const { server } = await boot();
    const port = server.port;
    expect((await call(port, 'POST', '/api/influence/weather', JSON_AUTH, '{"weather":')).status).toBe(400);
    const bad: [string, unknown][] = [
      ['weather', { weather: 'rain', hours: 2, extra: 1 }],
      ['weather', { weather: 'rain', hours: 4 }],
      ['weather', { weather: 'rain' }],
      ['weather', { weather: 'snow', hours: 1 }],
      ['weather', []],
      ['rumour', { to: 'laude', text: 'hi', source: 'player' }],
      ['rumour', { to: 'laude', text: 'hi', source: 'crow', from: 'bo' }],
      ['note', { to: 'franzi', text: 'hi', from: 'bo' }],
      ['nudge', { agent: 'laude', thought: 7 }],
      ['event', { title: 't', text: 'x', location: 'lake', time: '25:00' }],
      ['event', { title: 't', text: 'x', location: 'lake', time: '20:00', minutes: 20 }],
    ];
    for (const [e, body] of bad) {
      const r = await post(port, e, body);
      expect(r.status, `${e} ${JSON.stringify(body)}`).toBe(400);
      expect(r.json()).toHaveProperty('error');
    }
  });

  it('cleans text fields before the engine sees them; empty or too long after cleaning is 400', async () => {
    const seen: InfluenceRequest[] = [];
    const source: InfluenceSource = {
      applyInfluence: (req) => {
        seen.push(req);
        return { ok: true, id: 'inf_1', tick: 1, refs: {} };
      },
      influenceLog: () => ({ entries: [], budget: { limit: 6, usedToday: 0, resetsAtTick: 1440 } }),
    };
    const { server } = await boot({ source });
    const port = server.port;
    const raw = 'Franzi\nasked \u2028"why"\u202e\u0000 the\u200b post';
    expect((await post(port, 'nudge', { agent: 'laude', thought: raw })).status).toBe(200);
    expect(seen.at(-1)).toEqual({
      endpoint: 'nudge',
      body: { agent: 'laude', thought: "Franzi asked 'why' the post" },
    });
    expect((await post(port, 'note', { to: 'franzi', text: 'x', signed: ' the\ncrow ' })).status).toBe(200);
    expect(seen.at(-1)?.body).toEqual({ to: 'franzi', text: 'x', signed: 'the crow' });
    const zw = 'x'.repeat(300) + '\u200b'.repeat(100);
    expect((await post(port, 'rumour', { to: 'laude', text: zw, source: 'crow' })).status).toBe(200);
    const n = seen.length;
    expect((await post(port, 'rumour', { to: 'laude', text: 'x'.repeat(301), source: 'crow' })).status).toBe(
      400,
    );
    expect((await post(port, 'nudge', { agent: 'laude', thought: '\u200b \n' })).status).toBe(400);
    expect((await post(port, 'note', { to: 'franzi', text: 'x', signed: 'y'.repeat(25) })).status).toBe(400);
    expect(
      (await post(port, 'event', { title: 't'.repeat(41), text: 'x', location: 'lake', time: '20:00' }))
        .status,
    ).toBe(400);
    expect(seen).toHaveLength(n);
  });

  it('maps engine refusals to their status with the spec body (no ok/status fields)', async () => {
    const results: InfluenceResult[] = [
      { ok: false, status: 422, error: 'invalid', message: 'Unknown villager "zed".', field: 'agent' },
      { ok: false, status: 409, error: 'asleep', wakesAt: 1800 },
      { ok: false, status: 409, error: 'already_raining' },
      { ok: false, status: 503, error: 'busy' },
      { ok: false, status: 429, error: 'limit', resetsAtTick: 2880 },
    ];
    let i = 0;
    const source: InfluenceSource = {
      applyInfluence: () => results[i++]!,
      influenceLog: () => ({ entries: [], budget: { limit: 6, usedToday: 0, resetsAtTick: 1440 } }),
    };
    const { server } = await boot({ source });
    const got = [];
    for (let k = 0; k < results.length; k++) {
      const r = await post(server.port, 'weather', { weather: 'rain', hours: 1 });
      got.push([r.status, r.json()]);
    }
    expect(got).toEqual([
      [422, { error: 'invalid', message: 'Unknown villager "zed".', field: 'agent' }],
      [409, { error: 'asleep', wakesAt: 1800 }],
      [409, { error: 'already_raining' }],
      [503, { error: 'busy' }],
      [429, { error: 'limit', resetsAtTick: 2880 }],
    ]);
  });

  it('answers 500 without details when the engine throws', async () => {
    const source: InfluenceSource = {
      applyInfluence: () => {
        throw new Error('boom secret');
      },
      influenceLog: () => {
        throw new Error('boom secret');
      },
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { server } = await boot({ source });
    const r = await post(server.port, 'weather', { weather: 'clear' });
    expect(r.status).toBe(500);
    expect(r.body).not.toContain('boom');
    expect((await call(server.port, 'GET', '/api/influence/log', AUTH)).status).toBe(500);
  });

  it('is served on the game port only, never on the separate observer listener', async () => {
    const { server } = await boot({ config: { observer: { port: 0 } } });
    const obsPort = Number(new URL(server.observerUrl!).port);
    expect((await call(obsPort, 'GET', '/api/influence/log', AUTH)).status).toBe(404);
    expect(
      (await call(obsPort, 'POST', '/api/influence/weather', JSON_AUTH, '{"weather":"clear"}')).status,
    ).toBe(405);
    expect((await call(server.port, 'GET', '/api/influence/log', AUTH)).status).toBe(200);
  });
});

describe('GET /api/influence/log (spec §4.6, §6)', () => {
  it('pages like the observer and reports the budget in X-Influence-Budget', async () => {
    const { server, engine } = await boot({ config: { influence: { perGameDay: 0 } } });
    for (let i = 0; i < 3; i++)
      expect((await post(server.port, 'weather', { weather: 'rain', hours: 1 })).status).toBe(200);
    const all = await call(server.port, 'GET', '/api/influence/log', AUTH);
    expect(all.status).toBe(200);
    const entries = all.json() as { id: string; ts: string }[];
    expect(entries.map((e) => e.id)).toEqual(['inf_1', 'inf_2', 'inf_3']);
    expect(JSON.parse(String(all.headers['x-influence-budget']))).toEqual(engine.influence.budget());
    expect(all.headers['x-next-since']).toBe(entries[2]!.ts);

    const first = await call(
      server.port,
      'GET',
      `/api/influence/log?since=${encodeURIComponent('2000-01-01T00:00:00Z')}&limit=2`,
      AUTH,
    );
    const firstIds = (first.json() as { id: string }[]).map((e) => e.id);
    expect(firstIds).toEqual(['inf_1', 'inf_2']);
    const next = await call(
      server.port,
      `GET`,
      `/api/influence/log?since=${encodeURIComponent(String(first.headers['x-next-since']))}`,
      AUTH,
    );
    expect((next.json() as { id: string }[]).map((e) => e.id)).toEqual(['inf_3']);

    const byTick = await call(server.port, 'GET', `/api/influence/log?since=${engine.now() - 1}`, AUTH);
    expect((byTick.json() as unknown[]).length).toBe(3);
    const head = await call(server.port, 'HEAD', '/api/influence/log', AUTH);
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
    expect(head.headers['x-influence-budget']).toBeDefined();
    noCors(all);
  });

  it('caps limit at 200 and answers 400 for a bad since or limit', async () => {
    const seen: unknown[] = [];
    const source: InfluenceSource = {
      applyInfluence: () => ({ ok: false, status: 503, error: 'busy' }),
      influenceLog: (q) => {
        seen.push(q);
        return { entries: [], budget: { limit: 6, usedToday: 0, resetsAtTick: 1440 } };
      },
    };
    const { server } = await boot({ source });
    expect((await call(server.port, 'GET', '/api/influence/log?limit=5000&since=360', AUTH)).status).toBe(
      200,
    );
    expect(seen.at(-1)).toEqual({ limit: 200, since: 360 });
    for (const q of ['limit=abc', 'limit=0', 'limit=1.5', 'since=yesterday'])
      expect((await call(server.port, 'GET', `/api/influence/log?${q}`, AUTH)).status, q).toBe(400);
  });

  it("maps the service's RangeError to 400 and other errors to 500", async () => {
    let err: Error = new RangeError('"limit" must be a positive integer');
    const source: InfluenceSource = {
      applyInfluence: () => ({ ok: false, status: 503, error: 'busy' }),
      influenceLog: () => {
        throw err;
      },
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { server } = await boot({ source });
    expect((await call(server.port, 'GET', '/api/influence/log', AUTH)).status).toBe(400);
    err = new TypeError('x');
    expect((await call(server.port, 'GET', '/api/influence/log', AUTH)).status).toBe(500);
  });
});

describe('influence API logging (spec §3)', () => {
  it('logs its own refusals with method, path and status only: no token, body or query', async () => {
    const lines: string[] = [];
    const grab = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
    vi.spyOn(console, 'log').mockImplementation(grab);
    vi.spyOn(console, 'error').mockImplementation(grab);
    const { server } = await boot();
    const port = server.port;
    const secretText = 'SECRET-BODY-TEXT';
    await post(port, 'weather', { weather: 'rain', hours: 9, note: secretText });
    await post(
      port,
      'weather',
      { weather: 'clear', secretText },
      { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}zz` },
    );
    await call(port, 'POST', '/api/influence/weather', AUTH, secretText);
    await call(port, 'GET', `/api/influence/log?since=${secretText}`, AUTH);
    await call(port, 'GET', '/api/influence/nudge');
    const out = lines.join('\n');
    for (const status of [400, 401, 415, 405]) expect(out).toContain(`refused ${status}`);
    expect(out).toContain('GET /api/influence/log: refused 400');
    expect(out).not.toContain(secretText);
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain('since=');
  });
});

/** Raw TCP: writes `data`, collects everything until the server closes or `ms` passes. */
function rawTcp(
  port: number,
  data: string,
  ms = 400,
  onData?: (all: string, sock: Socket) => void,
): Promise<string> {
  return new Promise((resolve) => {
    let out = '';
    const sock = connectTcp(port, '127.0.0.1', () => sock.write(data));
    const timer = setTimeout(() => {
      sock.destroy();
      resolve(out);
    }, ms);
    sock.on('data', (c: Buffer) => {
      out += c.toString('latin1');
      onData?.(out, sock);
    });
    sock.on('error', () => {});
    sock.on('close', () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
}

describe('PR #77 review follow-ups (HTTP)', () => {
  const head = (port: number, auth: string, extra = '') =>
    `POST /api/influence/weather HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\n` +
    `Authorization: Bearer ${auth}\r\n${extra}`;

  it('F4: with Expect: 100-continue a bad token gets 401 without a 100 Continue first', async () => {
    const { server } = await boot();
    const out = await rawTcp(
      server.port,
      head(server.port, 'wrong', 'Content-Length: 20\r\nExpect: 100-continue\r\n\r\n'),
    );
    expect(out).toMatch(/^HTTP\/1\.1 401 /);
    expect(out).not.toContain('100 Continue');
  });

  it('F4: with a good token the server sends 100 Continue, then reads the body', async () => {
    const { server } = await boot();
    const body = '{"weather":"clear"}';
    let sent = false;
    const out = await rawTcp(
      server.port,
      head(server.port, TOKEN, `Content-Length: ${body.length}\r\nExpect: 100-continue\r\n\r\n`),
      600,
      (all, sock) => {
        if (!sent && all.includes('100 Continue')) {
          sent = true;
          sock.write(body);
        }
      },
    );
    expect(out).toMatch(/^HTTP\/1\.1 100 Continue\r\n\r\nHTTP\/1\.1 200 /);
  });

  it('F4: other routes still answer an Expect: 100-continue request', async () => {
    const { server } = await boot();
    const out = await rawTcp(
      server.port,
      `GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nContent-Length: 0\r\nExpect: 100-continue\r\n\r\n`,
    );
    expect(out).toContain('HTTP/1.1 200 ');
  });

  it('F5: a bodyless GET /log keeps the connection open, so pipelined polls all get answers', async () => {
    const { server } = await boot();
    const get = `GET /api/influence/log HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nAuthorization: Bearer ${TOKEN}\r\n\r\n`;
    const out = await rawTcp(server.port, get + get + get);
    expect(out.match(/HTTP\/1\.1 200 /g)).toHaveLength(3);
    expect(out.toLowerCase()).not.toContain('connection: close');
  });

  it('F5: a refusal with an unread body still closes the connection', async () => {
    const { server } = await boot();
    const out = await rawTcp(server.port, head(server.port, 'wrong', 'Content-Length: 100\r\n\r\n{"we'));
    expect(out).toMatch(/^HTTP\/1\.1 401 /);
    expect(out.toLowerCase()).toContain('connection: close');
  });

  it('F7: clear ignores hours; the stored payload has none', async () => {
    const seen: InfluenceRequest[] = [];
    const source: InfluenceSource = {
      applyInfluence: (req) => {
        seen.push(req);
        return { ok: true, id: 'inf_1', tick: 1, refs: {} };
      },
      influenceLog: () => ({ entries: [], budget: { limit: 6, usedToday: 0, resetsAtTick: 1440 } }),
    };
    const { server } = await boot({ source });
    expect((await post(server.port, 'weather', { weather: 'clear', hours: -5 })).status).toBe(200);
    expect(seen.at(-1)).toEqual({ endpoint: 'weather', body: { weather: 'clear' } });
    expect(parseInfluenceBody('weather', { weather: 'rain', hours: 2 }).body).toEqual({
      weather: 'rain',
      hours: 2,
    });
  });
});

describe('F6: token compare', () => {
  it('compares fixed-size digests, so any length gives the same answer path', () => {
    const want = 'w'.repeat(40);
    expect(tokenMatches(want, want)).toBe(true);
    for (const given of ['', 'w', 'w'.repeat(39), 'w'.repeat(41), 'x'.repeat(40), 'w'.repeat(4000)])
      expect(tokenMatches(given, want), String(given.length)).toBe(false);
  });

  it('checkAccess (observer and influence) uses it: wrong-length tokens get 401', () => {
    for (const authorization of ['Bearer a', `Bearer ${'t'.repeat(5000)}`])
      expect(
        checkAccess(
          { remoteAddress: '127.0.0.1', authorization },
          { allowRemote: false, token: 'secret-token' },
        ),
      ).toMatchObject({
        ok: false,
        status: 401,
      });
    expect(
      checkAccess(
        { remoteAddress: '127.0.0.1', authorization: 'bearer   secret-token  ' },
        { allowRemote: false, token: 'secret-token' },
      ),
    ).toEqual({ ok: true });
  });
});
