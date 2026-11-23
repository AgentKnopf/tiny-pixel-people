import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  KEEP_PAGE_MAX,
  NOTICE_MAX_LENGTH,
  type ClientMessage,
  type ServerMessage,
} from '../../src/shared/protocol.ts';
import type { PlayerState } from '../../src/shared/types.ts';
import { startServer, type RunningServer } from '../../src/server/net/server.ts';
import { parseClientMessage } from '../../src/server/net/validate.ts';
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

interface Client {
  ws: WebSocket;
  /** Sends `cmd`, then an unknown-type probe; resolves with every message received before the probe's error. */
  send(cmd: unknown): Promise<ServerMessage[]>;
  close(): void;
}

let probe = 0;

function connect(): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  let buffer: ServerMessage[] = [];
  let waiting: { id: string; resolve: (m: ServerMessage[]) => void } | null = null;
  return new Promise((resolve, reject) => {
    ws.once('error', reject);
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as ServerMessage;
      if (msg.type === 'hello') {
        resolve({
          ws,
          send: (cmd) =>
            new Promise((res) => {
              const id = `probe-${++probe}`;
              buffer = [];
              waiting = { id, resolve: res };
              ws.send(typeof cmd === 'string' ? cmd : JSON.stringify(cmd));
              ws.send(JSON.stringify({ type: 'probe', requestId: id }));
            }),
          close: () => ws.close(),
        });
        return;
      }
      if (waiting && msg.type === 'error' && msg.requestId === waiting.id) {
        const w = waiting;
        waiting = null;
        w.resolve(buffer);
        return;
      }
      buffer.push(msg);
    });
  });
}

const errors = (msgs: ServerMessage[]) =>
  msgs.filter((m): m is Extract<ServerMessage, { type: 'error' }> => m.type === 'error');

/** Errors the schema produced (not the gameplay handlers' friendly refusals). */
function schemaErrors(msgs: ServerMessage[], cmd: unknown): string[] {
  const expected = parseClientMessage(JSON.stringify(cmd));
  if (expected.ok) return errors(msgs).flatMap((e) => (/^[\w.]+: /.test(e.message) ? [e.message] : []));
  return errors(msgs)
    .filter((e) => e.message === expected.error)
    .map((e) => e.message);
}

function setPlayerPos(x: number, y: number): void {
  const p = engine.player as PlayerState;
  p.pos = { x, y };
  p.path = [];
}

function location(id: string) {
  const loc = engine.map.locations.find((l) => l.id === id);
  if (!loc) throw new Error(`no ${id} on the map`);
  return loc;
}

/** Every command the renderer sends (src/client/ui/**), with realistic payloads. */
function rendererCommands(resident: string): ClientMessage[] {
  return [
    { type: 'inspect', villagerId: resident },
    { type: 'inspect', villagerId: null },
    { type: 'speed', speed: 0 },
    { type: 'speed', speed: 1 },
    { type: 'save' },
    { type: 'player.move', to: { x: 20, y: 20 } },
    { type: 'player.say', villagerId: resident, text: 'Hello!', mode: 'say' },
    { type: 'player.say', villagerId: resident, text: 'Could you water the plants?', mode: 'ask' },
    { type: 'player.rumor', villagerId: resident, text: 'The baker sings at night.' },
    { type: 'player.pairTalk', aId: resident, bId: resident },
    { type: 'player.gift', villagerId: resident, itemId: 'flower' },
    { type: 'note.post', houseId: 'house_1', text: 'Hi there' },
    { type: 'decor.toggle', itemId: 'lamp' },
    { type: 'pet.command', action: 'pet' },
    { type: 'pet.command', action: 'stay' },
    { type: 'pet.command', action: 'follow' },
    { type: 'pet.command', action: 'rename', name: 'Biscuit' },
    { type: 'world.trigger', kind: 'rain' },
    { type: 'world.trigger', kind: 'party' },
    { type: 'world.trigger', kind: 'stranger' },
    { type: 'world.trigger', kind: 'birthday', villagerId: resident },
    { type: 'world.trigger', kind: 'townEvent' },
    { type: 'world.trigger', kind: 'train' },
    { type: 'player.enter', locationId: 'post_office' },
    { type: 'player.exit' },
    { type: 'player.ride', locationId: 'ferris_wheel' },
    { type: 'player.buy', locationId: 'burger_joint', itemId: 'burger' },
    { type: 'letter.send', to: resident, text: 'Dear friend, hello.' },
    { type: 'letter.read', letterId: 'letter_1' },
    { type: 'notice.post', text: 'Lost: one red scarf.' },
    { type: 'keep.open' },
    { type: 'keep.open', query: 'scarf', kind: 'notice', offset: 0, limit: 10 },
    { type: 'keep.open', kind: 'letter', offset: 10, limit: KEEP_PAGE_MAX },
  ];
}

describe('WebSocket boundary: v2 client commands', () => {
  it('passes every renderer command through validation (no schema errors)', async () => {
    const resident = engine.profiles.find((p) => !p.transient && !p.visitor)!.id;
    const client = await connect();
    for (const cmd of rendererCommands(resident)) {
      const cmdWithId = { ...cmd, requestId: `r-${cmd.type}` };
      expect(parseClientMessage(JSON.stringify(cmdWithId)).ok, cmd.type).toBe(true);
      const replies = await client.send(cmdWithId);
      expect(schemaErrors(replies, cmdWithId), JSON.stringify(cmd)).toEqual([]);
    }
    client.close();
  });

  it('changes server state for the v2 post office, notice and interior commands', async () => {
    const resident = engine.profiles.find((p) => !p.transient && !p.visitor)!;
    const client = await connect();
    const po = location('post_office');
    const door = po.door ?? po.entry;
    setPlayerPos(door.x, door.y);

    const entered = await client.send({ type: 'player.enter', locationId: 'post_office', requestId: 'e1' });
    expect(errors(entered)).toEqual([]);
    expect(engine.player.inside?.locationId).toBe('post_office');
    expect(
      entered.some((m) => m.type === 'player.updated' && m.player.inside?.locationId === 'post_office'),
    ).toBe(true);

    const keep = await client.send({
      type: 'keep.open',
      kind: 'letter',
      offset: 0,
      limit: 5,
      requestId: 'k1',
    });
    expect(keep.find((m) => m.type === 'keep.data')).toMatchObject({
      type: 'keep.data',
      offset: 0,
      requestId: 'k1',
    });

    const before = engine.snapshot().letters?.length ?? 0;
    const sent = await client.send({
      type: 'letter.send',
      to: resident.id,
      text: 'Hello from the post office',
      requestId: 'l1',
    });
    expect(errors(sent)).toEqual([]);
    expect(engine.snapshot().letters?.length ?? 0).toBe(before + 1);
    expect(sent.some((m) => m.type === 'letter.updated' && m.letter.to === resident.id)).toBe(true);

    const left = await client.send({ type: 'player.exit', requestId: 'x1' });
    expect(errors(left)).toEqual([]);
    expect(engine.player.inside ?? null).toBeNull();

    const board = location('notice_board');
    setPlayerPos(board.entry.x, board.entry.y);
    const posted = await client.send({ type: 'notice.post', text: 'Lost: one red scarf.', requestId: 'n1' });
    expect(errors(posted)).toEqual([]);
    expect(posted.some((m) => m.type === 'notice.updated' && m.notice.text.includes('red scarf'))).toBe(true);
    expect(engine.snapshot().notices?.some((n) => n.text.includes('red scarf'))).toBe(true);

    // Gameplay refusals still reach the client as friendly errors with the requestId.
    const readMissing = await client.send({
      type: 'letter.read',
      letterId: 'no_such_letter',
      requestId: 'rd1',
    });
    expect(errors(readMissing).map((e) => e.requestId)).toEqual(['rd1']);
    expect(schemaErrors(readMissing, { type: 'letter.read', letterId: 'no_such_letter' })).toEqual([]);
    client.close();
  });

  it('rejects malformed v2 payloads at the boundary, echoing the requestId', async () => {
    const client = await connect();
    const bad: unknown[] = [
      { type: 'player.enter', requestId: 'b1' },
      { type: 'player.enter', locationId: '', requestId: 'b2' },
      { type: 'player.ride', locationId: 42, requestId: 'b3' },
      { type: 'player.buy', locationId: 'burger_joint', requestId: 'b4' },
      { type: 'letter.send', to: 'x', requestId: 'b5' },
      { type: 'letter.send', to: 'x', text: 'a'.repeat(5000), requestId: 'b6' },
      { type: 'letter.read', requestId: 'b7' },
      { type: 'notice.post', text: 'a'.repeat(NOTICE_MAX_LENGTH * 2 + 1), requestId: 'b8' },
      { type: 'keep.open', limit: KEEP_PAGE_MAX + 1, requestId: 'b9' },
      { type: 'keep.open', offset: -1, requestId: 'b10' },
      { type: 'keep.open', kind: 'gossip', requestId: 'b11' },
      { type: 'world.trigger', kind: 'meteor', requestId: 'b12' },
      { type: 'player.teleport', requestId: 'b13' },
    ];
    const snapshotBefore = JSON.stringify(engine.snapshot());
    for (const cmd of bad) {
      const replies = await client.send(cmd);
      const errs = errors(replies);
      const rid = (cmd as { requestId: string }).requestId;
      expect(
        errs.map((e) => e.requestId),
        JSON.stringify(cmd),
      ).toEqual([rid]);
      expect(schemaErrors(replies, cmd).length, JSON.stringify(cmd)).toBe(1);
    }
    const replies = await client.send('{not json');
    expect(errors(replies).map((e) => e.message)).toEqual(['Invalid JSON']);
    expect(JSON.stringify(engine.snapshot())).toBe(snapshotBefore);
    client.close();
  });
});
