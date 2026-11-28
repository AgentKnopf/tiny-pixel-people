/**
 * HTTP side of the influence API (specs/influence-api-v2.md §3): /api/influence/{rumour,note,event,
 * nudge,weather} (POST) and /api/influence/log (GET). Served on the game port only. Checks run in
 * the spec's order, and the body is read only after the bearer token matched.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import {
  INFLUENCE_EVENT_MINUTES,
  INFLUENCE_LOG_PAGE_MAX,
  INFLUENCE_RAIN_HOURS,
  INFLUENCE_TEXT_MAX,
  RUMOUR_SOURCES,
  type ApplyInfluenceOptions,
  type InfluenceEndpoint,
  type InfluenceLogPage,
  type InfluenceLogQuery,
  type InfluenceRequest,
  type InfluenceResult,
} from '../../shared/influence.ts';
import type { AppConfig } from '../config.ts';
import { createLogger } from '../log.ts';
import { cleanInfluenceText } from './influence-text.ts';
import { checkAccess } from './observer.ts';
import { BadRequest, parseLimit, parseSince } from './observer-views.ts';

const log = createLogger('influence');

export type InfluenceConfig = AppConfig['influence'];

/** What the router needs from the engine. */
export interface InfluenceSource {
  applyInfluence(req: InfluenceRequest, opts?: ApplyInfluenceOptions): InfluenceResult;
  influenceLog(q: InfluenceLogQuery): InfluenceLogPage;
}

export interface InfluenceApiOptions {
  config: InfluenceConfig;
  /** null: every influence path answers 404, as when disabled. */
  source: InfluenceSource | null;
  /** Largest accepted body in bytes. Default 4 KiB. */
  maxBodyBytes?: number;
  /** Real ms allowed for the whole body to arrive. Default 5 s. */
  bodyTimeoutMs?: number;
}

export interface InfluenceApi {
  /** Handles every /api/influence path (404 while disabled); false for other paths. */
  handle(req: IncomingMessage, res: ServerResponse, url: URL): boolean;
}

const PREFIX = /^\/api\/influence(?:\/|$)/;
const LOG_PAGE_DEFAULT = 100;

const id = z.string().min(1).max(64);
const text = z.string().max(4096);
const SCHEMAS: Record<InfluenceEndpoint, z.ZodType> = {
  rumour: z.object({ to: id, text, source: z.enum(RUMOUR_SOURCES) }).strict(),
  note: z.object({ to: id, text, signed: text.optional() }).strict(),
  event: z
    .object({
      title: text,
      text,
      location: id,
      time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM'),
      minutes: z.number().int().min(INFLUENCE_EVENT_MINUTES.min).max(INFLUENCE_EVENT_MINUTES.max).optional(),
    })
    .strict(),
  nudge: z.object({ agent: id, thought: text }).strict(),
  weather: z.discriminatedUnion('weather', [
    z
      .object({
        weather: z.literal('rain'),
        hours: z.number().int().min(INFLUENCE_RAIN_HOURS.min).max(INFLUENCE_RAIN_HOURS.max),
      })
      .strict(),
    z.object({ weather: z.literal('clear'), hours: z.number().optional() }).strict(),
  ]),
};

/** Free-text fields per endpoint and their caps after cleaning. */
const TEXT_FIELDS: Record<InfluenceEndpoint, [string, number][]> = {
  rumour: [['text', INFLUENCE_TEXT_MAX.rumour]],
  note: [
    ['text', INFLUENCE_TEXT_MAX.note],
    ['signed', INFLUENCE_TEXT_MAX.signature],
  ],
  event: [
    ['title', INFLUENCE_TEXT_MAX.eventTitle],
    ['text', INFLUENCE_TEXT_MAX.eventText],
  ],
  nudge: [['thought', INFLUENCE_TEXT_MAX.nudge]],
  weather: [],
};

const ENDPOINT_PATHS = new Map<string, InfluenceEndpoint>(
  (Object.keys(SCHEMAS) as InfluenceEndpoint[]).map((e) => [`/api/influence/${e}`, e]),
);
const LOG_PATH = '/api/influence/log';

/** The path is percent-encoded ASCII (URL), but a caller chooses its length. */
const clip = (path: string) => (path.length > 80 ? `${path.slice(0, 80)}…` : path);

class HttpRefusal extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Schema check and §5 cleaning; the result is what gets applied, stored and logged. */
export function parseInfluenceBody(endpoint: InfluenceEndpoint, raw: unknown): InfluenceRequest {
  const parsed = SCHEMAS[endpoint].safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`);
    throw new BadRequest(issues.join('; '));
  }
  const body = { ...(parsed.data as Record<string, unknown>) };
  for (const [field, max] of TEXT_FIELDS[endpoint]) {
    if (body[field] === undefined) continue;
    const r = cleanInfluenceText(body[field], max);
    if (!r.ok)
      throw new BadRequest(
        r.reason === 'too_long'
          ? `"${field}" is longer than ${max} characters after cleaning`
          : `"${field}" is empty after cleaning`,
      );
    body[field] = r.text;
  }
  return { endpoint, body } as InfluenceRequest;
}

function send(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const raw = JSON.stringify(body);
  // An unread body: answer, then drop the connection instead of reading (or waiting for) the rest.
  const unread = !req.complete && !req.readableEnded;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(raw)),
    ...(unread ? { connection: 'close' } : {}),
    ...headers,
  });
  res.end(req.method === 'HEAD' ? undefined : raw);
  if (unread) res.once('finish', () => req.destroy());
}

function readBody(req: IncomingMessage, maxBytes: number, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const done = (err: HttpRefusal | null) => {
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      if (err) {
        req.pause();
        reject(err);
      } else resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const onData = (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) done(new HttpRefusal(413, `Body over ${maxBytes} bytes.`));
      else chunks.push(c);
    };
    const onEnd = () => done(null);
    const onError = () => done(new HttpRefusal(400, 'Body could not be read.'));
    const timer = setTimeout(() => done(new HttpRefusal(408, 'Body not received in time.')), timeoutMs);
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

export function createInfluenceApi(opts: InfluenceApiOptions): InfluenceApi {
  const cfg = opts.config;
  const maxBody = opts.maxBodyBytes ?? 4096;
  const timeoutMs = opts.bodyTimeoutMs ?? 5000;

  /** HTTP-layer refusal: logged with method, path and status only (never body, query or headers). */
  function refuse(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    status: number,
    error: string,
    headers: Record<string, string> = {},
  ): void {
    log.info(`${req.method ?? '?'} ${clip(path)}: refused ${status}`);
    send(req, res, status, { error }, headers);
  }

  async function post(
    source: InfluenceSource,
    req: IncomingMessage,
    res: ServerResponse,
    endpoint: InfluenceEndpoint,
    path: string,
  ): Promise<void> {
    const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (type !== 'application/json')
      return refuse(req, res, path, 415, 'Content-Type must be application/json.');
    const length = Number(req.headers['content-length']);
    if (Number.isFinite(length) && length > maxBody)
      return refuse(req, res, path, 413, `Body over ${maxBody} bytes.`);
    let parsedReq: InfluenceRequest;
    try {
      const raw = await readBody(req, maxBody, timeoutMs);
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        throw new BadRequest('Body is not valid JSON.');
      }
      parsedReq = parseInfluenceBody(endpoint, json);
    } catch (err) {
      if (err instanceof HttpRefusal) return refuse(req, res, path, err.status, err.message);
      if (err instanceof BadRequest) return refuse(req, res, path, 400, err.message);
      throw err;
    }
    const result = source.applyInfluence(parsedReq);
    if (result.ok) {
      const { ok: _ok, ...accepted } = result;
      return send(req, res, 200, accepted);
    }
    const { ok: _ok, status, ...refusal } = result;
    send(req, res, status, refusal);
  }

  function getLog(
    source: InfluenceSource,
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    path: string,
  ): void {
    let page: InfluenceLogPage;
    try {
      const since = parseSince(url.searchParams.get('since'));
      const q: InfluenceLogQuery = {
        limit: parseLimit(url.searchParams.get('limit'), LOG_PAGE_DEFAULT, INFLUENCE_LOG_PAGE_MAX),
        ...(since ? { since: 'tick' in since ? since.tick : new Date(since.ms).toISOString() } : {}),
      };
      page = source.influenceLog(q);
    } catch (err) {
      if (err instanceof BadRequest || err instanceof RangeError)
        return refuse(req, res, path, 400, err.message);
      throw err;
    }
    send(req, res, 200, page.entries, {
      'x-influence-budget': JSON.stringify(page.budget),
      ...(page.nextSince ? { 'x-next-since': page.nextSince } : {}),
    });
  }

  async function route(
    source: InfluenceSource,
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
    const path = url.pathname.replace(/\/$/, '');
    const endpoint = ENDPOINT_PATHS.get(path);
    if (!endpoint && path !== LOG_PATH) return refuse(req, res, path, 404, 'Not found');
    const allow = endpoint ? 'POST' : 'GET, HEAD';
    if (!allow.split(', ').includes(req.method ?? ''))
      return refuse(req, res, path, 405, `Use ${allow}.`, { allow });
    // allowRemote is off: loopback only. An empty token never matches (enabled needs >= 32 chars).
    const access = checkAccess(
      { remoteAddress: req.socket.remoteAddress, authorization: req.headers.authorization },
      { allowRemote: false, token: cfg.token || '\0' },
    );
    if (!access.ok)
      return refuse(
        req,
        res,
        path,
        access.status,
        access.status === 403 ? 'The influence API only accepts local clients.' : access.error,
        access.status === 401 ? { 'www-authenticate': 'Bearer' } : {},
      );
    if (endpoint) return post(source, req, res, endpoint, path);
    getLog(source, req, res, url, path);
  }

  return {
    handle(req, res, url) {
      if (!PREFIX.test(url.pathname)) return false;
      const source = opts.source;
      if (!cfg.enabled || !source) {
        send(req, res, 404, { error: 'Not found' });
        return true;
      }
      const path = url.pathname.replace(/\/$/, '');
      route(source, req, res, url).catch((err: unknown) => {
        log.error(`${req.method ?? '?'} ${clip(path)} failed`, err);
        if (!res.headersSent) send(req, res, 500, { error: 'Internal error' });
        else res.end();
      });
      return true;
    },
  };
}
