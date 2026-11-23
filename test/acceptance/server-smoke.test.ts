import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { HelloMessage, ServerMessage } from '../../src/shared/protocol.ts';
import { startServer, type RunningServer } from '../../src/server/net/server.ts';
import type { Engine } from '../../src/server/sim/engine.ts';
import { createSimTestWorld } from '../helpers/sim.ts';

let server: RunningServer;
let engine: Engine;

beforeAll(async () => {
  engine = createSimTestWorld({ startAt: '10:00' }).engine;
  server = await startServer({
    host: '127.0.0.1',
    port: 0,
    staticDir: 'dist/client',
    debug: false,
    llm: { provider: 'mock', model: 'mock', embeddings: null },
    engine,
    replayFile: () => engine.store.replayPath,
  });
});

afterAll(async () => {
  engine.stop();
  await server.close();
});

function connect(): Promise<{
  ws: WebSocket;
  hello: HelloMessage;
  next: (type: string) => Promise<ServerMessage>;
}> {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  const queue: ServerMessage[] = [];
  const waiters: { type: string; resolve: (m: ServerMessage) => void }[] = [];
  return new Promise((resolve, reject) => {
    ws.once('error', reject);
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as ServerMessage;
      if (msg.type === 'hello') {
        resolve({
          ws,
          hello: msg,
          next: (type) =>
            new Promise((res) => {
              const i = queue.findIndex((m) => m.type === type);
              if (i >= 0) res(queue.splice(i, 1)[0]!);
              else waiters.push({ type, resolve: res });
            }),
        });
        return;
      }
      const w = waiters.findIndex((x) => x.type === msg.type);
      if (w >= 0) waiters.splice(w, 1)[0]!.resolve(msg);
      else queue.push(msg);
    });
  });
}

describe('server smoke test', () => {
  it('answers /api/health', async () => {
    const res = await fetch(`${server.url}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, protocolVersion: 1 });
  });

  it('serves the snapshot, the observer state and the item catalog', async () => {
    const snapshot = await (await fetch(`${server.url}/api/snapshot`)).json();
    expect(snapshot.villagers.length).toBeGreaterThan(0);
    expect(snapshot.player.id).toBe('player');
    const state = await (await fetch(`${server.url}/api/state`)).json();
    expect(state.agents.length).toBe(snapshot.villagers.length);
    expect(state).toMatchObject({ day: 1, time: '10:00', player: { id: 'player' } });
    const catalog = await (await fetch(`${server.url}/api/catalog`)).json();
    expect(catalog.items.length).toBeGreaterThan(0);
    expect(catalog.decorations.length).toBeGreaterThan(0);
  });

  it('sends hello and routes commands over the WebSocket', async () => {
    const { ws, hello, next } = await connect();
    expect(hello.map.width).toBe(128);
    expect(hello.llm.provider).toBe('mock');
    expect(hello.map.scenes.map((s) => s.id)).toContain('home');
    expect(hello.snapshot.player.id).toBe('player');
    expect(hello.villagers.length).toBe(hello.snapshot.villagers.length);
    const id = hello.villagers[0]!.id;
    ws.send(JSON.stringify({ type: 'inspect', villagerId: id, requestId: 'r1' }));
    const data = await next('inspect.data');
    expect(data).toMatchObject({ type: 'inspect.data', villagerId: id });
    ws.send(JSON.stringify({ type: 'nonsense' }));
    expect((await next('error')).type).toBe('error');
    ws.close();
  });
});
