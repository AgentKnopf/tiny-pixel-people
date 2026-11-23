/**
 * AC1: one command starts the server (real entry point, mock provider, no network), serves health,
 * state and the WebSocket hello, and the client has no external URLs (fonts/CDNs). AC7 at the entry
 * point: the model name from config reaches the running server.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { HelloMessage } from '../../src/shared/protocol.ts';
import { repoPath } from '../helpers/features.ts';

const TSX = repoPath('node_modules/.bin/tsx');

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

interface Started {
  child: ChildProcess;
  url: string;
  output: () => string;
}

const children: ChildProcess[] = [];

async function startMain(model: string): Promise<Started> {
  const dir = mkdtempSync(join(tmpdir(), 'tpp-main-'));
  const port = await freePort();
  const configPath = join(dir, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      llm: { provider: 'mock', model },
      embeddings: { provider: 'mock' },
      server: { host: '127.0.0.1', port },
      persistence: { dir: join(dir, 'saves'), loadOnStart: false, autosaveGameMinutes: 0 },
    }),
  );
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('TPP_')) delete env[k];
  const child = spawn(TSX, ['src/server/main.ts', '--config', configPath, '--new'], {
    cwd: repoPath('./'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let out = '';
  child.stdout?.on('data', (d: Buffer) => (out += String(d)));
  child.stderr?.on('data', (d: Buffer) => (out += String(d)));
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}:\n${out}`);
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return { child, url, output: () => out };
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server did not start within 25 s:\n${out}`);
}

function hello(url: string): Promise<HelloMessage> {
  const ws = new WebSocket(`${url.replace('http', 'ws')}/ws`);
  return new Promise<HelloMessage>((resolve, reject) => {
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as { type: string };
      if (msg.type === 'hello') {
        ws.close();
        resolve(msg as HelloMessage);
      }
    });
    ws.once('error', reject);
  });
}

afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill('SIGTERM');
});

describe('AC1: one-command start (npm start entry point, mock provider)', () => {
  it('serves /api/health, /api/snapshot, /api/state and a WebSocket hello', async () => {
    const s = await startMain('mock-a');
    const health = (await (await fetch(`${s.url}/api/health`)).json()) as {
      ok: boolean;
      llm: { model: string };
    };
    expect(health.ok).toBe(true);
    const snapshot = (await (await fetch(`${s.url}/api/snapshot`)).json()) as {
      time: number;
      player: { id: string };
    };
    expect(typeof snapshot.time).toBe('number');
    expect(snapshot.player.id).toBe('player');
    const state = (await (await fetch(`${s.url}/api/state`)).json()) as {
      time: string;
      agents: { id: string }[];
    };
    expect(state.time).toMatch(/^\d{2}:\d{2}$/);
    expect(state.agents.length).toBeGreaterThan(0);
    const h = await hello(s.url);
    expect(h.protocolVersion).toBe(1);
    expect(h.map.width).toBeGreaterThan(0);
    expect(h.map.scenes.length).toBeGreaterThan(0);
  }, 40_000);

  it('AC7: swapping llm.model in config changes the running model, no code changes', async () => {
    for (const model of ['swap-model-one', 'swap-model-two']) {
      const s = await startMain(model);
      const health = (await (await fetch(`${s.url}/api/health`)).json()) as { llm: { model: string } };
      expect(health.llm.model).toBe(model);
      expect((await hello(s.url)).llm.model).toBe(model);
      s.child.kill('SIGTERM');
    }
  }, 60_000);
});

describe('AC1: the client works offline (no external URLs)', () => {
  const EXTERNAL = [
    /(?:src|href)\s*=\s*["']?(?:https?:)?\/\/(?!127\.0\.0\.1|localhost)/i,
    /url\(\s*["']?(?:https?:)?\/\/(?!127\.0\.0\.1|localhost)/i,
    /@import\s+(?:url\()?\s*["']?(?:https?:)?\/\//i,
    /fonts\.(?:googleapis|gstatic)\.com|cdn\.jsdelivr|unpkg\.com|cdnjs\.cloudflare/i,
  ];

  function files(dir: string, exts: string[]): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) return files(p, exts);
      return exts.includes(extname(p)) ? [p] : [];
    });
  }

  it('has no CDN, font or other external references in client sources or the built bundle', () => {
    const candidates = [
      ...files(repoPath('src/client'), ['.html', '.css', '.ts']),
      ...files(repoPath('dist/client'), ['.html', '.css', '.js']),
    ];
    expect(candidates.length).toBeGreaterThan(0);
    const offenders = candidates.flatMap((f) => {
      const text = readFileSync(f, 'utf8');
      return EXTERNAL.filter((re) => re.test(text)).map((re) => `${f}: ${re}`);
    });
    expect(offenders).toEqual([]);
  });
});
