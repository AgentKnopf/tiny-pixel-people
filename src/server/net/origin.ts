import { hostname, networkInterfaces } from 'node:os';

const WILDCARDS = new Set(['', '0.0.0.0', '::', '[::]']);

/** `name:port` as it appears in a Host header: lowercased, IPv6 in brackets. */
function key(name: string, port: number): string {
  const n = name.toLowerCase().replace(/^\[|\]$/g, '');
  return `${n.includes(':') ? `[${n}]` : n}:${port}`;
}

/**
 * Host values (`name:port`) under which this server may be reached: the loopback names, the
 * configured bind host, and for a wildcard bind (0.0.0.0 / ::) this machine's hostname and
 * interface addresses. Anything else in a Host or Origin header is another website (or a DNS
 * rebinding of one) and is refused.
 */
export function localHosts(host: string, port: number): Set<string> {
  const names = ['127.0.0.1', 'localhost', '::1'];
  if (WILDCARDS.has(host)) {
    names.push(hostname());
    for (const addrs of Object.values(networkInterfaces()))
      for (const a of addrs ?? []) names.push(a.address);
  } else names.push(host);
  return new Set(names.map((n) => key(n, port)));
}

const HOST_RE = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::([1-9]\d{0,4}))?$/i;

/** True if a Host header names this server. A missing port means 80, as in HTTP. */
export function hostAllowed(host: string | undefined, allowed: Set<string>): boolean {
  const m = host ? HOST_RE.exec(host) : null;
  if (!m) return false;
  return allowed.has(key(m[1]!, m[2] ? Number(m[2]) : 80));
}

/** True if an Origin header is one of this server's own http:// origins. */
export function originAllowed(origin: string, allowed: Set<string>): boolean {
  const m = /^http:\/\/([^/]+)$/i.exec(origin);
  return m ? hostAllowed(m[1], allowed) : false;
}

const LOG_EVERY_MS = 60_000;
const LOG_MAX_KEYS = 1000;
const LOG_CLIP = 100;

/** Printable ASCII only, clipped: the values come straight from a possibly hostile request. */
function clean(value: string | undefined): string {
  if (value === undefined) return '(none)';
  const s = value.replace(/[^\x20-\x7e]/g, '?');
  return s.length > LOG_CLIP ? `${s.slice(0, LOG_CLIP)}…` : s;
}

/**
 * Warning lines for refused connections, at most one per origin/host pair a minute, so a page
 * that retries in a loop can't flood the log.
 */
export class RefusalLog {
  private readonly last = new Map<string, number>();

  get size(): number {
    return this.last.size;
  }

  line(origin: string | undefined, host: string | undefined, now: number): string | null {
    const o = clean(origin);
    const h = clean(host);
    const k = `${o} ${h}`;
    const prev = this.last.get(k);
    if (prev !== undefined && now - prev < LOG_EVERY_MS) return null;
    if (this.last.size >= LOG_MAX_KEYS) this.last.clear();
    this.last.set(k, now);
    return `refused WebSocket from origin ${o}, host ${h}`;
  }
}
