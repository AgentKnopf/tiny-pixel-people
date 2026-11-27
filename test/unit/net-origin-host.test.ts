/** TASK-17: other websites can neither drive the game over the WebSocket nor read /api/* (DNS rebinding). */
import { request } from 'node:http';
import { hostname, networkInterfaces } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { WS_PATH } from '../../src/shared/protocol.ts';
import { localHosts, originAllowed, hostAllowed } from '../../src/server/net/origin.ts';
import { startServer, type RunningServer } from '../../src/server/net/server.ts';
import type { PartialConfig } from '../../src/server/config.ts';
import { createSimTestWorld } from '../helpers/sim.ts';

const running: RunningServer[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
});

async function boot(host = '127.0.0.1', config: PartialConfig = {}) {
  const { engine } = createSimTestWorld({ config });
  const server = await startServer({
    host,
    port: 0,
    staticDir: 'dist/client',
    debug: false,
    llm: { provider: 'mock', model: 'mock-model', embeddings: null },
    engine,
    observer: { config: engine.config.observer, source: engine },
  });
  running.push(server);
  return server;
}

/** GET with an explicit Host header (fetch can't set one); `null` sends no Host at all. */
function get(port: number, path: string, host: string | null): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: 'GET', setHost: host !== null, headers: host ? { host } : {} },
      (res) => {
        let body = '';
        res.on('data', (c: Buffer) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** Opens the game WebSocket; resolves with "open" or the HTTP status of the refused upgrade. */
function connect(port: number, headers: { origin?: string; host?: string } = {}): Promise<'open' | number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`, {
      ...(headers.origin ? { origin: headers.origin } : {}),
      ...(headers.host ? { headers: { host: headers.host } } : {}),
    });
    ws.on('open', () => {
      ws.close();
      resolve('open');
    });
    ws.on('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.on('error', () => resolve(-1));
  });
}

describe('local host set', () => {
  it('holds the loopback names and the configured host, all with the port', () => {
    const set = localHosts('192.168.1.20', 3000);
    for (const h of ['127.0.0.1:3000', 'localhost:3000', '[::1]:3000', '192.168.1.20:3000'])
      expect(set.has(h)).toBe(true);
    expect(set.has('192.168.1.20:3001')).toBe(false);
    expect(set.has('evil.example:3000')).toBe(false);
  });

  it("with a wildcard bind adds this machine's addresses and hostname", () => {
    const set = localHosts('0.0.0.0', 3000);
    expect(set.has(`${hostname().toLowerCase()}:3000`)).toBe(true);
    const v4 = Object.values(networkInterfaces())
      .flat()
      .find((a) => a && a.family === 'IPv4');
    if (v4) expect(set.has(`${v4.address}:3000`)).toBe(true);
    expect(set.has('0.0.0.0:3000')).toBe(false);
  });

  it('parses Host and Origin values strictly', () => {
    const set = localHosts('127.0.0.1', 3000);
    expect(hostAllowed('LOCALHOST:3000', set)).toBe(true);
    expect(hostAllowed('localhost', set)).toBe(false);
    expect(hostAllowed(undefined, set)).toBe(false);
    expect(hostAllowed('localhost:3000@evil.example', set)).toBe(false);
    expect(originAllowed('http://localhost:3000', set)).toBe(true);
    expect(originAllowed('https://localhost:3000', set)).toBe(false);
    expect(originAllowed('null', set)).toBe(false);
    expect(originAllowed('http://localhost:3000.evil.example', set)).toBe(false);
    expect(localHosts('127.0.0.1', 80).has('localhost:80')).toBe(true);
    expect(hostAllowed('localhost', localHosts('127.0.0.1', 80))).toBe(true);
  });
});

describe('WebSocket upgrade', () => {
  it("accepts the game page from the server's own origins", async () => {
    const { port } = await boot();
    for (const origin of [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`])
      expect(await connect(port, { origin }), origin).toBe('open');
  });

  it('accepts a client without an Origin header (scripts and tools, never a browser page)', async () => {
    const { port } = await boot();
    expect(await connect(port)).toBe('open');
  });

  it('refuses other websites with 403', async () => {
    const { port } = await boot();
    for (const origin of [
      'http://evil.example',
      `http://evil.example:${port}`,
      `http://localhost:${port + 1}`,
      `https://127.0.0.1:${port}`,
      'null',
    ])
      expect(await connect(port, { origin }), origin).toBe(403);
  });

  it('refuses a foreign Host (DNS rebinding) even without an Origin', async () => {
    const { port } = await boot();
    expect(await connect(port, { host: `evil.example:${port}` })).toBe(403);
  });
});

describe('HTTP /api/* Host check', () => {
  const paths = ['/api/health', '/api/snapshot', '/api/state', '/api/agents/mia/memories', '/api/stats'];

  it('serves the local names with the right port', async () => {
    const { port } = await boot();
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`])
      for (const path of paths) expect((await get(port, path, host)).status, `${host}${path}`).toBe(200);
  });

  it('refuses a foreign or wrong-port Host with 403, observer routes included', async () => {
    const { port } = await boot();
    for (const host of [
      `evil.example:${port}`,
      'evil.example',
      `127.0.0.1:${port + 1}`,
      `localhost:${port}.evil.example`,
    ])
      for (const path of paths) {
        const res = await get(port, path, host);
        expect(res.status, `${host}${path}`).toBe(403);
        expect(res.body).not.toContain('mia');
      }
  });

  it('refuses a request without a Host header', async () => {
    const { port } = await boot();
    // Node answers 400 itself (requireHostHeader) before the handler runs; either way no data.
    const res = await get(port, '/api/state', null);
    expect([400, 403]).toContain(res.status);
    expect(res.body).not.toContain('mia');
  });

  it("a server bound to all interfaces answers on this machine's hostname", async () => {
    const { port } = await boot('0.0.0.0');
    expect((await get(port, '/api/health', `${hostname()}:${port}`)).status).toBe(200);
    expect((await get(port, '/api/health', `evil.example:${port}`)).status).toBe(403);
  });

  it('the separate observer listener checks the Host too', async () => {
    const server = await boot('127.0.0.1', { observer: { port: 0 } });
    const port = Number(new URL(server.observerUrl!).port);
    expect((await get(port, '/api/state', `127.0.0.1:${port}`)).status).toBe(200);
    expect((await get(port, '/api/state', `evil.example:${port}`)).status).toBe(403);
  });
});
