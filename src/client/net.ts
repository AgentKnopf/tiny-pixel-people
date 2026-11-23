import { WS_PATH, type ClientMessage, type ServerMessage } from '../shared/protocol.ts';

export type NetStatus = 'connecting' | 'connected' | 'disconnected';

export interface Connection {
  /** Send a command; returns false (and drops it) when the socket is not open. */
  send(msg: ClientMessage): boolean;
  readonly status: NetStatus;
  close(): void;
}

/** Minimal WebSocket surface used here, so tests can pass a fake. */
export interface SocketLike {
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface ConnectOptions {
  /** Full ws:// URL; default derives from `location`. */
  url?: string;
  createSocket?: (url: string) => SocketLike;
  /** Injected timer for tests. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  minRetryMs?: number;
  maxRetryMs?: number;
}

const OPEN = 1;

export function defaultWsUrl(loc: { protocol: string; host: string }): string {
  const proto = loc.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${loc.host}${WS_PATH}`;
}

/** Parse one frame; returns null for non-JSON or frames without a string `type`. */
export function parseServerMessage(data: unknown): ServerMessage | null {
  try {
    const msg: unknown = JSON.parse(String(data));
    if (msg && typeof msg === 'object' && typeof (msg as { type?: unknown }).type === 'string') {
      return msg as ServerMessage;
    }
  } catch {
    // fall through
  }
  return null;
}

/** Connect to the server WebSocket and reconnect with exponential backoff when it drops. */
export function connect(
  onMessage: (msg: ServerMessage) => void,
  onStatus: (status: NetStatus, text: string) => void,
  opts: ConnectOptions = {},
): Connection {
  const minRetry = opts.minRetryMs ?? 500;
  const maxRetry = opts.maxRetryMs ?? 10_000;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const createSocket = opts.createSocket ?? ((url) => new WebSocket(url) as unknown as SocketLike);
  const url = opts.url ?? defaultWsUrl(location);

  let ws: SocketLike | null = null;
  let closed = false;
  let retry = minRetry;
  let timer: unknown = null;
  let status: NetStatus = 'connecting';

  const setStatus = (s: NetStatus, text: string) => {
    status = s;
    onStatus(s, text);
  };

  const scheduleReconnect = () => {
    if (closed || timer !== null) return;
    setStatus('disconnected', `disconnected, retrying in ${Math.round(retry / 1000)}s…`);
    timer = setTimer(() => {
      timer = null;
      open();
    }, retry);
    retry = Math.min(retry * 2, maxRetry);
  };

  const open = () => {
    if (closed) return;
    setStatus('connecting', 'connecting…');
    let sock: SocketLike;
    try {
      sock = createSocket(url);
    } catch {
      scheduleReconnect();
      return;
    }
    ws = sock;
    sock.onopen = () => {
      retry = minRetry;
      setStatus('connected', 'connected');
    };
    sock.onmessage = (ev) => {
      const msg = parseServerMessage(ev.data);
      if (msg) onMessage(msg);
    };
    sock.onerror = () => {
      // onclose follows and handles the retry.
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      scheduleReconnect();
    };
  };
  open();

  return {
    send(msg) {
      if (ws?.readyState !== OPEN) return false;
      ws.send(JSON.stringify(msg));
      return true;
    },
    get status() {
      return status;
    },
    close() {
      closed = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
      const s = ws;
      ws = null;
      s?.close();
    },
  };
}
