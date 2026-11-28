/** TASK-18 I2: startup with the influence API on (AC2): readable ConfigError, and the token never reaches the log. */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const TSX = join(ROOT, 'node_modules/.bin/tsx');

/** Runs the real server entry point until `until` appears in its output or it exits. */
function runMain(token: string, until: RegExp): Promise<{ out: string; code: number | null }> {
  const dir = mkdtempSync(join(tmpdir(), 'tpp-inf-start-'));
  const config = join(dir, 'config.json');
  writeFileSync(
    config,
    JSON.stringify({
      llm: { provider: 'mock' },
      embeddings: { provider: 'none' },
      server: { port: 0 },
      persistence: { dir: join(dir, 'saves'), loadOnStart: false, autosaveGameMinutes: 0 },
      influence: { enabled: true },
    }),
  );
  return new Promise((done, fail) => {
    const child = spawn(TSX, ['src/server/main.ts', '--config', config, '--new'], {
      cwd: ROOT,
      detached: true,
      env: { ...process.env, INFLUENCE_TOKEN: token, TPP_LOG_LEVEL: 'debug', TPP_CONFIG: '' },
    });
    let out = '';
    let finished = false;
    const finish = (code: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        // Already gone.
      }
      done({ out, code });
    };
    const onData = (c: Buffer) => {
      out += c;
      if (until.test(out)) finish(null);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', fail);
    child.on('exit', (code) => finish(code));
    const timer = setTimeout(() => finish(null), 20_000);
  });
}

describe('influence startup (AC2)', () => {
  it('fails with a readable ConfigError when the token is too short, without printing it', async () => {
    const token = 'short-token-abcdefghijklmnopqrs';
    expect(token).toHaveLength(31);
    const { out, code } = await runMain(token, /a^/);
    expect(code).toBe(1);
    expect(out).toContain('influence.token');
    expect(out).not.toContain(token);
  }, 30_000);

  it('starts, says where the API is, and keeps the token out of the log and the debug config dump', async () => {
    const token = 'start-token-0123456789-abcdefghijkl';
    const { out } = await runMain(token, /influence API at .*\n/);
    expect(out).toMatch(/influence API at http:\/\/127\.0\.0\.1:\d+\/api\/influence\//);
    expect(out).toContain('effective config');
    expect(out).toContain("token: '***'");
    expect(out).not.toContain(token);
  }, 30_000);
});
