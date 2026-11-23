import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { HelloMessage } from '../../src/shared/protocol.ts';
import { startServer, type RunningServer } from '../../src/server/net/server.ts';
import { createPlaceholderMap, createPlaceholderSnapshot } from '../../src/server/sim/placeholder.ts';

let server: RunningServer;

beforeAll(async () => {
  const map = createPlaceholderMap();
  server = await startServer({
    host: '127.0.0.1',
    port: 0,
    staticDir: 'dist/client',
    debug: false,
    llm: { provider: 'mock', model: 'mock', embeddings: null },
    getMap: () => map,
    getSnapshot: () => createPlaceholderSnapshot(360, 1),
  });
});

afterAll(async () => {
  await server.close();
});

describe('server smoke test', () => {
  it('answers /api/health', async () => {
    const res = await fetch(`${server.url}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, protocolVersion: 1 });
  });

  it('sends hello over the WebSocket', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    const hello = await new Promise<HelloMessage>((resolve, reject) => {
      ws.once('message', (data) => resolve(JSON.parse(String(data)) as HelloMessage));
      ws.once('error', reject);
    });
    ws.close();
    expect(hello.type).toBe('hello');
    expect(hello.map.width).toBe(40);
    expect(hello.llm.provider).toBe('mock');
    expect(hello.map.scenes.map((s) => s.id)).toContain('home');
    expect(hello.snapshot.player.id).toBe('player');
  });
});
