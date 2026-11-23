import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

export interface FakeReply {
  status?: number;
  headers?: Record<string, string>;
  /** Objects are sent as JSON, strings verbatim. */
  body?: unknown;
  delayMs?: number;
}

export type FakeHandler = (req: RecordedRequest) => FakeReply | Promise<FakeReply>;

export interface FakeServer {
  url: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

/** A local HTTP server that records requests and answers with scripted provider responses. */
export async function startFakeServer(handler: FakeHandler): Promise<FakeServer> {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = undefined;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
      const rec: RecordedRequest = {
        method: req.method ?? '',
        path: req.url ?? '',
        headers: req.headers,
        body,
      };
      requests.push(rec);
      void Promise.resolve(handler(rec)).then(async (reply) => {
        if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
        if (res.destroyed) return;
        const payload = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {});
        res.writeHead(reply.status ?? 200, { 'content-type': 'application/json', ...reply.headers });
        res.end(payload);
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
