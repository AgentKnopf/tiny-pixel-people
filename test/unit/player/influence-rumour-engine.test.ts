/** TASK-18 I5: rumour influence through HTTP and the real engine and minds (spec §4.1, AC5, AC4). */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '../../../src/server/net/server.ts';
import type { Engine } from '../../../src/server/sim/engine.ts';
import type { RumourOutcomes } from '../../../src/shared/influence.ts';
import { at } from '../../../src/shared/time.ts';
import { PLAYER_ID } from '../../../src/shared/types.ts';
import { createSimTestWorld } from '../../helpers/sim.ts';
import { createTestWorld, type TestWorld } from '../../helpers/world.ts';

const TOKEN = 'influence-rumour-token-0123456789abcdefg';
const HEADERS = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
const PLAYER_NAME = 'Kestrel';
const CONFIG = { influence: { enabled: true, token: TOKEN }, player: { name: PLAYER_NAME } };
const A = 'mia';
const B = 'tom';
const TEXT = 'The bakery will sell cherry pie tomorrow.';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

async function boot(engine: Engine) {
  const server = await startServer({
    host: '127.0.0.1',
    port: 0,
    staticDir: 'dist/client',
    debug: false,
    llm: { provider: 'mock', model: 'mock-model', embeddings: null },
    engine,
    observer: { config: engine.config.observer, source: engine },
    influence: { config: engine.config.influence },
  });
  closers.push(() => server.close());
  return async (body: unknown) => {
    const r = await fetch(`http://127.0.0.1:${server.port}/api/influence/rumour`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  };
}

describe('POST /api/influence/rumour', () => {
  it('200 with the origin id; unknown source 400, unknown target 422, sleeping target 409', async () => {
    const { engine } = createSimTestWorld({ config: CONFIG, startAt: '10:00' });
    const post = await boot(engine);
    const [a, b] = engine.snapshot().villagers;

    const ok = await post({ to: a!.id, text: TEXT, source: 'child' });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ id: 'inf_1', refs: { originId: expect.stringMatching(/^fact_\d+$/) } });

    expect((await post({ to: a!.id, text: TEXT, source: 'the player' })).status).toBe(400);
    expect(await post({ to: 'nobody', text: TEXT, source: 'crow' })).toMatchObject({
      status: 422,
      json: { error: 'invalid', field: 'to' },
    });

    const rt = (engine as unknown as { runtimes: Map<string, { state: { status: string } }> }).runtimes;
    rt.get(b!.id)!.state.status = 'sleeping';
    const asleep = await post({ to: b!.id, text: TEXT, source: 'crow' });
    expect(asleep).toEqual({ status: 409, json: { error: 'asleep', wakesAt: engine.now() + 1 } });
    expect(engine.influence.budget().usedToday).toBe(1);
  });
});

describe('AC5: an influence rumour spreads through the normal gossip path', () => {
  let w: TestWorld | undefined;
  let originId = '';
  let sentAt = 0;
  let spreadAt: number | null = null;

  beforeAll(async () => {
    const world = await createTestWorld({ villagers: 12, seed: 25, startAt: '10:00', config: CONFIG });
    w = world;
    sentAt = world.now();
    const res = world.engine.applyInfluence({
      endpoint: 'rumour',
      body: { to: A, text: TEXT, source: 'passerby' },
    });
    if (!res.ok) throw new Error(`rumour refused: ${JSON.stringify(res)}`);
    originId = res.refs.originId!;
    expect(world.command({ type: 'player.pairTalk', aId: A, bId: B })).toEqual([]);
    const spread = () =>
      world.engine.townLog
        .list()
        .some((e) => e.type === 'gossip_spread' && e.data?.originId === originId && e.agents.includes(B));
    await world.until(() => spread(), 120, 1);
    if (spread()) spreadAt = world.now();
  }, 300_000);

  afterAll(() => w?.dispose());

  it('A remembers it with influenceId, importance 7 and the source label', () => {
    const m = w!.memories(A).find((x) => x.meta.originId === originId && x.kind === 'heard');
    expect(m).toMatchObject({
      importance: 7,
      text: `A passerby told me: ${TEXT}`,
      meta: { influenceId: 'inf_1' },
    });
  });

  it('within 2 game hours of a forced talk, gossip_spread matches the origin and spreadTo has B', () => {
    expect(spreadAt).not.toBeNull();
    expect(spreadAt! - sentAt).toBeLessThanOrEqual(120);
    const [entry] = w!.engine.influenceLog({}).entries;
    expect((entry!.outcomes as RumourOutcomes).spreadTo).toContainEqual(
      expect.objectContaining({ from: A, to: B }),
    );
  });

  it("no villager memory and no Keep entry contains the player's name", () => {
    const ids = w!.state().villagers.map((v) => v.id);
    const leaks = ids.flatMap((id) => w!.memories(id).filter((m) => m.text.includes(PLAYER_NAME)));
    expect(leaks.map((m) => `${m.villagerId}: ${m.text}`)).toEqual([]);
    const keep = w!.engine.playerWorld.post.keep.all();
    expect(keep.some((e) => e.text.startsWith('Rumor started by A passerby:'))).toBe(true);
    expect(keep.filter((e) => e.text.includes(PLAYER_NAME))).toEqual([]);
  });

  it('the rumour panel shows the truth: the player started it', () => {
    expect(sentAt).toBe(at(0, '10:00'));
    expect(w!.engine.playerWorld.rumors.byOrigin(originId)).toMatchObject({
      startedBy: PLAYER_ID,
      text: TEXT,
    });
  });
});
