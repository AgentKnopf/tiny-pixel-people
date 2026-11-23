/**
 * Live acceptance run against the provider in config.json (spec §14, "Live" column).
 *
 *   npm run test:live -- [--config path] [--speed 4] [--day-length 15] [--max-minutes 90]
 *                        [--villagers 10] [--report live-report.json]
 *
 * Starts the real server (src/server/main.ts) on a free port with a temporary save dir and debug
 * commands on, runs one game day from 06:00 and judges AC1–AC7 with the same checks as the mock
 * suite (test/helpers/checks.ts). Exit code 0 = all checks passed.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { loadConfig, redactConfig } from '../src/server/config.ts';
import { createProviders } from '../src/server/llm/index.ts';
import type {
  ClientMessage,
  ConversationMessageMsg,
  HelloMessage,
  InspectDataMsg,
  ServerMessage,
  StatsMsg,
} from '../src/shared/protocol.ts';
import type { Conversation, DoorNote, WorldSnapshot } from '../src/shared/types.ts';
import { at, formatClock } from '../src/shared/time.ts';
import {
  checkEvents,
  checkGossip,
  checkInspector,
  checkNote,
  checkPlans,
  formatReport,
  gossipMentions,
  planAdherence,
  type AdherenceSample,
  type CheckResult,
} from '../test/helpers/checks.ts';
import { attachProvenance } from '../test/helpers/provenance.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const FACT = "The mayor's cat is named Biscuit.";
const FACT_KEYWORD = 'Biscuit';
const NOTE = 'Could you water the sunflowers by the fountain tomorrow morning?';

interface Args {
  config?: string;
  speed: number;
  dayLength?: number;
  maxMinutes: number;
  villagers?: number;
  report?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { speed: 4, maxMinutes: 90 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] ?? '';
    if (a === '--config') out.config = next();
    else if (a === '--speed') out.speed = Number(next());
    else if (a === '--day-length') out.dayLength = Number(next());
    else if (a === '--max-minutes') out.maxMinutes = Number(next());
    else if (a === '--villagers') out.villagers = Number(next());
    else if (a === '--report') out.report = next();
    else if (a === '--help' || a === '-h') {
      console.log(
        'usage: npm run test:live -- [--config path] [--speed 1|2|4|8] [--day-length min] [--max-minutes n] [--villagers n] [--report file]',
      );
      process.exit(0);
    }
  }
  if (![1, 2, 4, 8].includes(out.speed)) throw new Error('--speed must be 1, 2, 4 or 8');
  return out;
}

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => res(port));
    });
  });
}

const minToClock = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const log = (msg: string) => console.log(`[live] ${msg}`);

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (typeof process.loadEnvFile === 'function') {
    try {
      process.loadEnvFile(resolve(ROOT, '.env'));
    } catch {
      // no .env
    }
  }
  const cfg = loadConfig({ cwd: ROOT, ...(args.config ? { path: args.config } : {}) });
  const { sourcePath, ...plain } = cfg;
  log(`config: ${sourcePath ?? 'defaults'}; provider ${cfg.llm.provider}, model ${cfg.llm.model}`);
  if (cfg.llm.provider === 'mock') log('warning: provider is "mock"; this is not a real-model run');

  const results: CheckResult[] = [];

  // AC1 (part 1): the configured model answers its health check.
  let llmHealth: { ok: boolean; message: string };
  try {
    llmHealth = await createProviders(cfg).chat.health();
  } catch (err) {
    llmHealth = { ok: false, message: (err as Error).message };
  }
  log(`LLM health: ${llmHealth.ok ? 'ok' : 'FAILED'} (${llmHealth.message})`);

  const dir = mkdtempSync(join(tmpdir(), 'tpp-live-'));
  const port = await freePort();
  const runConfig = {
    ...plain,
    sim: {
      ...plain.sim,
      startTime: '06:00',
      ...(args.dayLength ? { dayLengthMinutes: args.dayLength } : {}),
      ...(args.villagers ? { villagers: args.villagers } : {}),
    },
    server: { host: '127.0.0.1', port },
    persistence: {
      ...plain.persistence,
      dir: join(dir, 'saves'),
      loadOnStart: false,
      autosaveGameMinutes: 0,
    },
    debug: true,
  };
  const configPath = join(dir, 'config.json');
  // The temp config may contain a literal apiKey copied from config.json; it is deleted on exit.
  writeFileSync(configPath, JSON.stringify(runConfig), { mode: 0o600 });
  log(`effective run config: ${JSON.stringify(redactConfig(runConfig).sim)}`);

  const child = spawn(
    join(ROOT, 'node_modules/.bin/tsx'),
    ['src/server/main.ts', '--config', configPath, '--new'],
    {
      cwd: ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let serverOut = '';
  child.stdout.on('data', (d: Buffer) => (serverOut = (serverOut + String(d)).slice(-20_000)));
  child.stderr.on('data', (d: Buffer) => (serverOut = (serverOut + String(d)).slice(-20_000)));
  const cleanup = () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    rmSync(dir, { recursive: true, force: true });
  };
  process.once('SIGINT', () => {
    cleanup();
    process.exit(130);
  });

  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 150 && !up; i++) {
    if (child.exitCode !== null) break;
    up = (await getJson(`${base}/api/health`)) !== null;
    if (!up) await sleep(200);
  }
  results.push({
    id: 'AC1',
    title: 'server starts with one command and the configured model is reachable',
    pass: up && llmHealth.ok,
    detail: `server ${up ? 'up' : 'DOWN'}; LLM: ${llmHealth.message}`,
  });
  if (!up) {
    console.error(serverOut);
    finish(results, args, cleanup);
    return;
  }

  const messages: ServerMessage[] = [];
  let lastStats: StatsMsg | null = null;
  let lastStatus = '';
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const hello = await new Promise<HelloMessage>((res, rej) => {
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as ServerMessage;
      if (msg.type === 'hello') res(msg);
      else if (msg.type === 'stats') lastStats = msg;
      else if (msg.type !== 'tick') messages.push(msg);
      if (msg.type === 'sim.status') {
        // The server repeats the wakingUp status every few seconds for late-joining clients.
        const status = `${msg.phase}: ${msg.plansReady}/${msg.villagers} plans ready`;
        if (status !== lastStatus) log(`sim ${status} (real ${new Date().toISOString().slice(11, 19)})`);
        lastStatus = status;
      } else if (msg.type === 'log' && msg.text.startsWith('LLM use so far'))
        log(`server at ${formatClock(msg.time)}: ${msg.text}`);
    });
    ws.once('error', rej);
  });
  const send = (cmd: ClientMessage) => ws.send(JSON.stringify(cmd));
  results.push({
    id: 'AC7',
    title: 'the model from config is the one the server runs',
    pass: hello.llm.provider === cfg.llm.provider && hello.llm.model === cfg.llm.model,
    detail: `hello.llm = ${hello.llm.provider}/${hello.llm.model}; config = ${cfg.llm.provider}/${cfg.llm.model}`,
  });
  send({ type: 'speed', speed: args.speed as 1 | 2 | 4 | 8 });

  const start = hello.snapshot.time;
  const day0 = Math.floor(start / 1440);
  const t = (hhmm: string) => at(day0, hhmm);
  const end = at(day0 + 1, '00:00');
  const deadline = Date.now() + args.maxMinutes * 60_000;
  const samples: AdherenceSample[] = [];
  let factSource: string | null = null;
  let noteHouse: string | null = null;
  let inspected = false;
  let last: WorldSnapshot = hello.snapshot;
  let lastLog = 0;
  const inspections: { id: string; msg: InspectDataMsg | undefined }[] = [];

  while (Date.now() < deadline && last.time < end && child.exitCode === null) {
    await sleep(2000);
    const s = await getJson<WorldSnapshot>(`${base}/api/state`);
    if (!s) continue;
    last = s;
    samples.push({ time: s.time, villagers: s.villagers });
    if (Date.now() - lastLog > 30_000) {
      lastLog = Date.now();
      log(
        `game time ${formatClock(s.time)}, ${s.villagers.length} villagers, ${s.events.length} events, ${messages.filter((m) => m.type === 'conversation.message').length} conversation lines`,
      );
    }
    if (!factSource && s.time >= t('08:00')) {
      const a = s.villagers.find((v) => v.status !== 'sleeping') ?? s.villagers[0];
      if (a) {
        factSource = a.id;
        send({ type: 'debug.inject', villagerId: a.id, text: FACT, importance: 8 });
        log(`told ${a.id}: "${FACT}" at ${formatClock(s.time)}`);
      }
    }
    if (!noteHouse && s.time >= t('08:00')) {
      const owner = s.villagers.find((v) => {
        const home = hello.villagers.find((p) => p.id === v.id)?.homeId;
        return v.status !== 'sleeping' && v.locationId !== null && v.locationId !== home;
      });
      const homeId = owner && hello.villagers.find((p) => p.id === owner.id)?.homeId;
      if (homeId) {
        noteHouse = homeId;
        send({ type: 'note.post', houseId: homeId, text: NOTE });
        log(`posted a note on ${homeId} while ${owner!.id} is away (${formatClock(s.time)})`);
      }
    }
    if (!inspected && s.time >= t('12:00')) {
      inspected = true;
      for (const v of s.villagers) {
        send({ type: 'inspect', villagerId: v.id });
        await sleep(300);
        const msg = [...messages]
          .reverse()
          .find((m): m is InspectDataMsg => m.type === 'inspect.data' && m.villagerId === v.id);
        inspections.push({ id: v.id, msg });
      }
      send({ type: 'inspect', villagerId: null });
    }
  }
  if (last.time < end)
    log(`stopped at game time ${formatClock(last.time)} (real-time limit ${args.maxMinutes} min)`);

  const midday = samples.find((s) => s.time >= t('12:00'));
  const judgedVillagers = midday?.villagers ?? last.villagers;
  const adherence = planAdherence(samples, hello.map.locations);
  const plans = checkPlans({ ...last, villagers: judgedVillagers }, adherence);
  results.push(plans);
  if (!plans.pass) {
    // The save dir is deleted on exit, so this is the only record of what the flagged plans said.
    for (const v of judgedVillagers.filter((v) => plans.detail.includes(`${v.id}:`))) {
      const a = adherence.find((x) => x.villagerId === v.id);
      const blocks = (v.plan?.blocks ?? []).map(
        (b) => `${minToClock(b.start)} ${b.locationId} (${b.activity})`,
      );
      log(
        `AC2 detail ${v.id}: plan ${v.plan?.source ?? 'none'} rev ${v.plan?.revision ?? '-'}, ` +
          `adherence ${a ? `${a.following}/${a.samples}` : '-'}, ${a?.locationsVisited ?? 0} location(s); ` +
          (blocks.join('; ') || 'no blocks'),
      );
    }
  }

  const wsLines = messages.filter((m): m is ConversationMessageMsg => m.type === 'conversation.message');
  const apiConvos = (await getJson<Conversation[]>(`${base}/api/conversations`)) ?? [];
  const apiLines: ConversationMessageMsg[] = apiConvos.flatMap((c) =>
    c.messages.map((m) => ({
      type: 'conversation.message' as const,
      conversationId: c.id,
      speakerId: m.speakerId,
      listenerId: c.participants.find((p) => p !== m.speakerId) ?? '',
      text: m.text,
      time: m.at,
      ...(m.source ? { source: m.source } : {}),
    })),
  );
  const gossipHits = factSource
    ? gossipMentions([...wsLines, ...apiLines], FACT_KEYWORD, factSource, t('08:00'), t('20:00'))
    : [];
  results.push(
    factSource
      ? checkGossip([...wsLines, ...apiLines], FACT_KEYWORD, factSource, t('08:00'), t('20:00'))
      : { id: 'AC3', title: 'gossip', pass: false, detail: 'never reached 08:00' },
  );

  const note: DoorNote | undefined = last.notes.find((n) => n.houseId === noteHouse && n.text === NOTE);
  results.push(
    noteHouse
      ? checkNote(note)
      : { id: 'AC4', title: 'door note', pass: false, detail: 'no owner away from home' },
  );
  results.push(checkEvents(last.events));
  results.push(
    inspections.length
      ? checkInspector(inspections)
      : { id: 'AC6', title: 'inspector', pass: false, detail: 'never reached 12:00' },
  );
  ws.close();
  printDiagnostics(lastStats, messages);
  const stats = lastStats as StatsMsg | null;
  const attributed = attachProvenance(results, {
    plans: judgedVillagers.map((v) => v.plan),
    gossipHits,
    note,
    goodEvents: last.events.filter((e) => e.status === 'done' && new Set(e.attendees).size >= 3),
    taskStats: stats?.queue.byTask,
  });
  finish(attributed, args, cleanup);
}

/** Queue stats and server warnings, to tell a slow model (timeouts, fallbacks) from a logic bug. */
function printDiagnostics(stats: StatsMsg | null, messages: readonly ServerMessage[]): void {
  if (stats) {
    const q = stats.queue;
    log(
      `LLM queue: ${q.done} done, ${q.failed} failed, ${q.queued} still queued, avg ${(q.avgLatencyMs / 1000).toFixed(1)} s per call`,
    );
    for (const [task, s] of Object.entries(q.byTask ?? {}))
      log(
        `  ${task.padEnd(16)} ${String(s.done).padStart(4)} done ${String(s.failed).padStart(4)} failed  avg ${(s.avgLatencyMs / 1000).toFixed(1)} s`,
      );
  }
  const warnings = messages.filter((m) => m.type === 'log' && m.level !== 'info') as { text: string }[];
  if (warnings.length) {
    log(`${warnings.length} server warnings/errors, first distinct ones:`);
    for (const text of [...new Set(warnings.map((w) => w.text))].slice(0, 8)) log(`  ${text.slice(0, 160)}`);
  }
}

function finish(results: CheckResult[], args: Args, cleanup: () => void): void {
  cleanup();
  const order = ['AC1', 'AC2', 'AC3', 'AC4', 'AC5', 'AC6', 'AC7'];
  results.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  console.log(`\n${formatReport(results)}`);
  if (args.report) {
    writeFileSync(args.report, JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
    log(`report written to ${args.report}`);
  }
  process.exit(results.every((r) => r.pass) ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error('[live] fatal:', err);
  process.exit(2);
});
