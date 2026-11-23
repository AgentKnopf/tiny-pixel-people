import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AppConfig } from '../config.ts';
import { createLogger } from '../log.ts';
import { BadRequest, ObserverViews, type ObserverSource, type Paged } from './observer-views.ts';
import { ScreenshotRenderer } from './screenshot.ts';

const log = createLogger('observer');

export type ObserverConfig = AppConfig['observer'];

export interface ObserverOptions {
  config: ObserverConfig;
  source: ObserverSource;
  llm: { provider: string; model: string };
  /** Directory with tiles/ and characters/ PNGs for GET /api/screenshot. Default: ./assets. */
  assetsDir?: string;
}

const PATHS =
  /^\/api\/(?:state|agents\/[^/]+(?:\/memories)?|conversations|notes|events|stats|screenshot|letters|notices|keep|animals)\/?$/;

/** True for the paths the observer API serves (whether or not it is enabled). */
export function isObserverPath(pathname: string): boolean {
  return PATHS.test(pathname);
}

export function isLoopback(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
  return a === '::1' || /^127\.\d+\.\d+\.\d+$/.test(a);
}

export type AccessResult = { ok: true } | { ok: false; status: 401 | 403; error: string };

/**
 * Loopback clients only, unless `allowRemote` is on and a token is set. With a token, every request
 * (loopback included) must send `Authorization: Bearer <token>`.
 */
export function checkAccess(
  req: { remoteAddress: string | undefined; authorization: string | undefined },
  cfg: Pick<ObserverConfig, 'allowRemote' | 'token'>,
): AccessResult {
  if (!isLoopback(req.remoteAddress) && !(cfg.allowRemote && cfg.token)) {
    return { ok: false, status: 403, error: 'The observer API only accepts local clients.' };
  }
  if (cfg.token) {
    const m = /^Bearer\s+(.+)$/i.exec(req.authorization ?? '');
    const given = Buffer.from(m?.[1]?.trim() ?? '');
    const want = Buffer.from(cfg.token);
    if (given.length !== want.length || !timingSafeEqual(given, want)) {
      return { ok: false, status: 401, error: 'Missing or wrong bearer token.' };
    }
  }
  return { ok: true };
}

function send(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(raw)),
    ...headers,
  });
  res.end(req.method === 'HEAD' ? undefined : raw);
}

function sendPaged(req: IncomingMessage, res: ServerResponse, page: Paged<unknown>): void {
  send(req, res, 200, page.items, page.nextSince ? { 'x-next-since': page.nextSince } : {});
}

export interface ObserverApi {
  /** Handles the request if it is an observer path; false otherwise. */
  handle(req: IncomingMessage, res: ServerResponse, url: URL): boolean;
}

export function createObserverApi(opts: ObserverOptions): ObserverApi {
  const views = new ObserverViews(opts.source, opts.llm);
  let renderer: ScreenshotRenderer | null = null;
  const cfg = opts.config;

  function route(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const path = url.pathname.replace(/\/$/, '');
    const q = url.searchParams;
    if (path === '/api/state') return send(req, res, 200, views.state());
    if (path === '/api/stats') return send(req, res, 200, views.stats());
    if (path === '/api/conversations') return sendPaged(req, res, views.conversations(q));
    if (path === '/api/notes') return sendPaged(req, res, views.notes(q));
    if (path === '/api/events') return sendPaged(req, res, views.events(q));
    if (path === '/api/letters') return sendPaged(req, res, views.letters(q));
    if (path === '/api/notices') return send(req, res, 200, views.notices());
    if (path === '/api/keep') return sendPaged(req, res, views.keep(q));
    if (path === '/api/animals') return send(req, res, 200, views.animals(q));
    if (path === '/api/screenshot') return screenshot(req, res, q);
    const m = /^\/api\/agents\/([^/]+)(\/memories)?$/.exec(path);
    if (m) {
      const id = decodeURIComponent(m[1]!);
      const body = m[2] ? views.memories(id, q) : views.agent(id);
      if (!body) return send(req, res, 404, { error: `Unknown agent "${id}"` });
      return 'items' in body ? sendPaged(req, res, body) : send(req, res, 200, body);
    }
    send(req, res, 404, { error: 'Not found' });
  }

  function screenshot(req: IncomingMessage, res: ServerResponse, q: URLSearchParams): void {
    const raw = q.get('scale');
    const scale = raw === null ? 1 : Number(raw);
    if (!Number.isInteger(scale) || scale < 1 || scale > 4)
      throw new BadRequest('"scale" must be 1, 2, 3 or 4');
    const src = opts.source;
    renderer ??= new ScreenshotRenderer(src.map, opts.assetsDir);
    const figures = src.villagerIds().flatMap((id) => {
      const s = src.villager(id);
      const p = src.profile(id);
      return s && p ? [{ pos: s.pos, facing: s.facing, sprite: p.sprite }] : [];
    });
    const player = src.playerWorld.state;
    figures.push({ pos: player.pos, facing: player.facing, sprite: 'characters/player.png' });
    let png: Buffer;
    try {
      png = renderer.render(figures, scale);
    } catch (err) {
      log.warn(`screenshot failed: ${(err as Error).message}`);
      return send(req, res, 501, { error: `Screenshot not available: ${(err as Error).message}` });
    }
    res.writeHead(200, {
      'content-type': 'image/png',
      'cache-control': 'no-store',
      'content-length': String(png.length),
    });
    res.end(req.method === 'HEAD' ? undefined : png);
  }

  return {
    handle(req, res, url) {
      if (!cfg.enabled || !isObserverPath(url.pathname)) return false;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        send(
          req,
          res,
          405,
          { error: 'The observer API is read-only (GET and HEAD only).' },
          { allow: 'GET, HEAD' },
        );
        return true;
      }
      const access = checkAccess(
        { remoteAddress: req.socket.remoteAddress, authorization: req.headers.authorization },
        cfg,
      );
      if (!access.ok) {
        send(
          req,
          res,
          access.status,
          { error: access.error },
          access.status === 401 ? { 'www-authenticate': 'Bearer' } : {},
        );
        return true;
      }
      try {
        route(req, res, url);
      } catch (err) {
        if (err instanceof BadRequest) send(req, res, 400, { error: err.message });
        else {
          log.error(`${url.pathname} failed`, err);
          send(req, res, 500, { error: 'Internal error' });
        }
      }
      return true;
    },
  };
}

export interface RunningObserver {
  port: number;
  url: string;
  close(): Promise<void>;
}

/** Separate listener (config observer.port) that serves only the observer API. */
export async function startObserverServer(
  api: ObserverApi,
  host: string,
  port: number,
): Promise<RunningObserver> {
  const http = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (api.handle(req, res, url)) return;
    const raw = JSON.stringify({ error: 'Not found' });
    res.writeHead(req.method === 'GET' || req.method === 'HEAD' ? 404 : 405, {
      'content-type': 'application/json; charset=utf-8',
    });
    res.end(raw);
  });
  await new Promise<void>((ok, fail) => {
    http.once('error', fail);
    http.listen(port, host, () => ok());
  });
  const actual = (http.address() as AddressInfo).port;
  return {
    port: actual,
    url: `http://${host.includes(':') ? `[${host}]` : host}:${actual}`,
    close: () => new Promise<void>((r) => http.close(() => r())),
  };
}
