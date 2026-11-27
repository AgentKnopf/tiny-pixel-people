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

const HOST_RE = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?$/i;

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
