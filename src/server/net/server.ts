import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { PROTOCOL_VERSION, WS_PATH, type ServerMessage } from '../../shared/protocol.ts';
import type { WorldMap, WorldSnapshot } from '../../shared/types.ts';
import { createLogger } from '../log.ts';

const log = createLogger('net');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export interface ServerOptions {
  host: string;
  port: number;
  /** Directory with the built client (vite build output). */
  staticDir: string;
  llm: { provider: string; model: string; embeddings: string | null };
  debug: boolean;
  /** Placeholder until WP2 provides SimEngine. */
  getMap: () => WorldMap;
  getSnapshot: () => WorldSnapshot;
}

export interface RunningServer {
  port: number;
  url: string;
  broadcast(msg: ServerMessage): void;
  close(): Promise<void>;
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const staticRoot = resolve(opts.staticDir);

  const http = createServer((req, res) => {
    void handleHttp(req, res).catch((err: unknown) => {
      log.error('HTTP handler failed', err);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true, protocolVersion: PROTOCOL_VERSION, llm: opts.llm });
      return;
    }
    if (url.pathname === '/api/state') {
      sendJson(res, 200, opts.getSnapshot());
      return;
    }
    serveStatic(staticRoot, url.pathname, res);
  }

  const wss = new WebSocketServer({ server: http, path: WS_PATH });
  const send = (ws: WebSocket, msg: ServerMessage) => ws.send(JSON.stringify(msg));

  wss.on('connection', (ws) => {
    send(ws, {
      type: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      map: opts.getMap(),
      villagers: [],
      snapshot: opts.getSnapshot(),
      llm: opts.llm,
      debug: opts.debug,
    });
    ws.on('message', (data) => {
      // Command handling is wired to SimEngine.handleCommand by WP2.
      log.debug(`ws message: ${String(data).slice(0, 200)}`);
    });
  });

  await new Promise<void>((resolveListen, reject) => {
    http.once('error', reject);
    http.listen(opts.port, opts.host, () => resolveListen());
  });
  const port = (http.address() as AddressInfo).port;

  return {
    port,
    url: `http://${opts.host}:${port}`,
    broadcast(msg) {
      const raw = JSON.stringify(msg);
      for (const client of wss.clients) if (client.readyState === client.OPEN) client.send(raw);
    },
    async close() {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
      await new Promise<void>((r) => http.close(() => r()));
    },
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': MIME['.json']! });
  res.end(JSON.stringify(body));
}

function serveStatic(root: string, pathname: string, res: ServerResponse): void {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  let file = join(root, rel);
  if (!file.startsWith(root)) {
    res.writeHead(403);
    res.end();
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html');
  if (!existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Client not built. Run "npm start" (or "npm run build:client").');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
}
