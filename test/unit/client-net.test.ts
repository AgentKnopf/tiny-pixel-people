import { describe, expect, it } from 'vitest';
import { connect, defaultWsUrl, parseServerMessage, type SocketLike } from '../../src/client/net.ts';
import type { ServerMessage } from '../../src/shared/protocol.ts';

class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sent: string[] = [];
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.({});
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({});
  }
}

function setup() {
  const sockets: FakeSocket[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const messages: ServerMessage[] = [];
  const statuses: string[] = [];
  const conn = connect(
    (m) => messages.push(m),
    (s) => statuses.push(s),
    {
      url: 'ws://test/ws',
      createSocket: (url) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
      setTimer: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length;
      },
      clearTimer: () => {},
    },
  );
  return { conn, sockets, timers, messages, statuses };
}

describe('client net', () => {
  it('builds the ws URL from the page location', () => {
    expect(defaultWsUrl({ protocol: 'http:', host: 'localhost:3000' })).toBe('ws://localhost:3000/ws');
    expect(defaultWsUrl({ protocol: 'https:', host: 'x.dev' })).toBe('wss://x.dev/ws');
  });

  it('parses frames and ignores junk', () => {
    expect(parseServerMessage('{"type":"tick","time":1,"speed":1,"villagers":[]}')?.type).toBe('tick');
    expect(parseServerMessage('not json')).toBeNull();
    expect(parseServerMessage('{"no":"type"}')).toBeNull();
  });

  it('sends only while open and delivers messages', () => {
    const { conn, sockets, messages, statuses } = setup();
    expect(conn.send({ type: 'save' })).toBe(false);
    sockets[0]!.open();
    expect(conn.status).toBe('connected');
    expect(conn.send({ type: 'speed', speed: 2 })).toBe(true);
    expect(JSON.parse(sockets[0]!.sent[0]!)).toEqual({ type: 'speed', speed: 2 });
    sockets[0]!.onmessage?.({ data: '{"type":"toast","icon":"x","text":"hi"}' });
    sockets[0]!.onmessage?.({ data: 'garbage' });
    expect(messages.map((m) => m.type)).toEqual(['toast']);
    expect(statuses).toEqual(['connecting', 'connected']);
  });

  it('reconnects with exponential backoff that resets after a successful open', () => {
    const { conn, sockets, timers } = setup();
    sockets[0]!.drop();
    expect(conn.status).toBe('disconnected');
    expect(timers.map((t) => t.ms)).toEqual([500]);
    timers[0]!.fn();
    expect(sockets).toHaveLength(2);
    sockets[1]!.drop();
    timers[1]!.fn();
    sockets[2]!.drop();
    expect(timers.map((t) => t.ms)).toEqual([500, 1000, 2000]);
    timers[2]!.fn();
    sockets[3]!.open();
    sockets[3]!.drop();
    expect(timers.at(-1)!.ms).toBe(500);
  });

  it('stops reconnecting after close()', () => {
    const { conn, sockets, timers } = setup();
    sockets[0]!.open();
    conn.close();
    expect(timers).toHaveLength(0);
    expect(sockets).toHaveLength(1);
  });
});
