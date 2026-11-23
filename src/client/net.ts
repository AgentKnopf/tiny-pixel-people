import { WS_PATH, type ClientMessage, type ServerMessage } from '../shared/protocol.ts';

export interface Connection {
  send(msg: ClientMessage): void;
  close(): void;
}

/** Connect to the server WebSocket and reconnect with backoff when it drops. */
export function connect(onMessage: (msg: ServerMessage) => void, onStatus: (s: string) => void): Connection {
  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 500;

  const open = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}${WS_PATH}`);
    ws.onopen = () => {
      retry = 500;
      onStatus('connected');
    };
    ws.onmessage = (ev) => onMessage(JSON.parse(String(ev.data)) as ServerMessage);
    ws.onclose = () => {
      if (closed) return;
      onStatus('disconnected, retrying…');
      setTimeout(open, retry);
      retry = Math.min(retry * 2, 10_000);
    };
  };
  open();

  return {
    send: (msg) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    },
    close: () => {
      closed = true;
      ws?.close();
    },
  };
}
