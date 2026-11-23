import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { PROTOCOL_VERSION, WS_PATH, type ServerMessage } from '../../shared/protocol.ts';
import type { VillagerId } from '../../shared/types.ts';
import { createLogger } from '../log.ts';
import { loadCatalogs, type Catalogs } from '../player/index.ts';
import { DEFAULT_CONFIG } from '../config.ts';
import { Engine, toPublicProfile } from '../sim/engine.ts';
import type { SimEngine } from '../sim/types.ts';
import {
  createObserverApi,
  startObserverServer,
  type ObserverConfig,
  type RunningObserver,
} from './observer.ts';
import type { ObserverSource } from './observer-views.ts';
import { parseClientMessage } from './validate.ts';

const log = createLogger('net');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
};

/** How often subscribed inspectors are refreshed (real ms). */
const INSPECT_REFRESH_MS = 1000;

export interface ServerOptions {
  host: string;
  port: number;
  /** Directory with the built client (vite build output). */
  staticDir: string;
  llm: { provider: string; model: string; embeddings: string | null };
  debug: boolean;
  engine: SimEngine;
  /** Path of replay.jsonl served at GET /api/replay (WP5). */
  replayFile?: () => string | null;
  /** Items and decorations for GET /api/catalog. Default: data/items.json + data/decorations.json. */
  catalog?: () => Catalogs;
  /**
   * Read-only observer API (GET /api/state, /api/agents/…, /api/events, …). Defaults: config
   * DEFAULT_CONFIG.observer, source = `engine` when it is the real engine (otherwise off).
   */
  observer?: { config?: ObserverConfig; source?: ObserverSource; assetsDir?: string };
}

export interface RunningServer {
  port: number;
  url: string;
  /** Base URL of the separate observer listener (config observer.port), else null. */
  observerUrl: string | null;
  broadcast(msg: ServerMessage): void;
  close(): Promise<void>;
}

interface ClientState {
  inspecting: VillagerId | null;
  lastInspect: string;
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const staticRoot = resolve(opts.staticDir);
  const engine = opts.engine;
  let catalog: Catalogs | undefined;
  const pick = ({ items, decorations }: Catalogs): Catalogs => ({ items, decorations });
  const observerConfig = opts.observer?.config ?? DEFAULT_CONFIG.observer;
  const observerSource = opts.observer?.source ?? (engine instanceof Engine ? engine : null);
  const observer =
    observerSource && observerConfig.enabled
      ? createObserverApi({
          config: observerConfig,
          source: observerSource,
          llm: opts.llm,
          ...(opts.observer?.assetsDir ? { assetsDir: opts.observer.assetsDir } : {}),
        })
      : null;
  const separateObserver = observer !== null && observerConfig.port !== null;

  const http = createServer((req, res) => {
    void handleHttp(req, res).catch((err: unknown) => {
      log.error('HTTP handler failed', err);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!separateObserver && observer?.handle(req, res, url)) return;
    if (url.pathname.startsWith('/api/') && req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': MIME['.json']!, allow: 'GET, HEAD' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    switch (url.pathname) {
      case '/api/health':
        sendJson(res, 200, {
          ok: true,
          protocolVersion: PROTOCOL_VERSION,
          llm: opts.llm,
          time: engine.now(),
        });
        return;
      case '/api/snapshot':
        // Full WorldSnapshot (same data as the WebSocket hello); the observer's /api/state is the summary.
        sendJson(res, 200, engine.snapshot());
        return;
      case '/api/catalog': {
        catalog ??= opts.catalog?.() ?? pick(loadCatalogs());
        sendJson(res, 200, catalog);
        return;
      }
      case '/api/rumors':
        sendJson(res, 200, engine.snapshot().rumors);
        return;
      case '/api/replay': {
        const file = opts.replayFile?.() ?? null;
        if (!file || !existsSync(file)) {
          sendJson(res, 404, { error: 'No replay saved yet. Press "Save replay" first.' });
          return;
        }
        res.writeHead(200, {
          'content-type': MIME['.jsonl']!,
          'content-disposition': 'attachment; filename="replay.jsonl"',
        });
        res.end(readFileSync(file));
        return;
      }
    }
    if (url.pathname.startsWith('/api/')) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }
    serveStatic(staticRoot, url.pathname, res);
  }

  const wss = new WebSocketServer({ server: http, path: WS_PATH });
  const clients = new Map<WebSocket, ClientState>();
  const send = (ws: WebSocket, msg: ServerMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  const broadcastRaw = (raw: string) => {
    for (const client of wss.clients) if (client.readyState === client.OPEN) client.send(raw);
  };
  const unsubscribe = engine.onMessage((msg) => broadcastRaw(JSON.stringify(msg)));

  const refreshInspectors = () => {
    for (const [ws, st] of clients) {
      if (!st.inspecting) continue;
      const [msg] = engine.handleCommand({ type: 'inspect', villagerId: st.inspecting });
      if (!msg) continue;
      const raw = JSON.stringify(msg);
      if (raw === st.lastInspect) continue;
      st.lastInspect = raw;
      if (ws.readyState === ws.OPEN) ws.send(raw);
    }
  };
  const inspectTimer = setInterval(refreshInspectors, INSPECT_REFRESH_MS);

  wss.on('connection', (ws) => {
    const st: ClientState = { inspecting: null, lastInspect: '' };
    clients.set(ws, st);
    send(ws, {
      type: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      map: engine.map,
      villagers: engine.profiles.map(toPublicProfile),
      snapshot: engine.snapshot(),
      llm: opts.llm,
      debug: opts.debug,
    });
    ws.on('message', (data) => {
      const parsed = parseClientMessage(String(data));
      if (!parsed.ok) {
        send(
          ws,
          parsed.requestId
            ? { type: 'error', message: parsed.error, requestId: parsed.requestId }
            : { type: 'error', message: parsed.error },
        );
        return;
      }
      const cmd = parsed.msg;
      if (cmd.type === 'inspect') {
        st.inspecting = cmd.villagerId;
        st.lastInspect = '';
      }
      for (const reply of engine.handleCommand(cmd)) {
        if (reply.type === 'inspect.data') st.lastInspect = JSON.stringify(reply);
        send(ws, reply);
      }
    });
    ws.on('close', () => clients.delete(ws));
    ws.on('error', (err) => log.debug(`ws error: ${err.message}`));
  });

  await new Promise<void>((resolveListen, reject) => {
    http.once('error', reject);
    http.listen(opts.port, opts.host, () => resolveListen());
  });
  const port = (http.address() as AddressInfo).port;
  let observerServer: RunningObserver | null = null;
  if (observer && separateObserver) {
    try {
      observerServer = await startObserverServer(observer, observerConfig.host, observerConfig.port!);
      log.info(`observer API at ${observerServer.url}`);
    } catch (err) {
      await new Promise<void>((r) => http.close(() => r()));
      throw err;
    }
  }

  return {
    port,
    url: `http://${opts.host}:${port}`,
    observerUrl: observerServer?.url ?? null,
    broadcast(msg) {
      broadcastRaw(JSON.stringify(msg));
    },
    async close() {
      clearInterval(inspectTimer);
      unsubscribe();
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
      await new Promise<void>((r) => http.close(() => r()));
      await observerServer?.close();
    },
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': MIME['.json']! });
  res.end(JSON.stringify(body));
}

function serveStatic(root: string, pathname: string, res: ServerResponse): void {
  let rel: string;
  try {
    rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
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
