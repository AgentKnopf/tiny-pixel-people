/**
 * §14.1 Player features: gold and tasks, backpack and gifts, pet, home decorating. Spec §7.11–§7.16.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { PlayerUpdatedMsg } from '../../src/shared/protocol.ts';
import { PLAYER_HOME_ID, PLAYER_ID, type DecorationItem, type Point } from '../../src/shared/types.ts';
import { at } from '../../src/shared/time.ts';
import { featurePath, ready, repoPath, SIM_FEATURES, waitingFor, type Feature } from '../helpers/features.ts';
import { awake, createTestWorld, type TestWorld } from '../helpers/world.ts';

let w: TestWorld | undefined;
afterEach(() => w?.dispose());

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const player = (tw: TestWorld) => tw.state().player;
const count = (tw: TestWorld, itemId: string) =>
  player(tw).inventory.find((i) => i.itemId === itemId)?.count ?? 0;

function catalog<T>(feature: Feature, key: string): T[] {
  const raw = JSON.parse(readFileSync(repoPath(featurePath(feature)), 'utf8')) as unknown;
  return (Array.isArray(raw) ? raw : ((raw as Record<string, T[]>)[key] ?? [])) as T[];
}

async function walkTo(tw: TestWorld, to: Point, maxMinutes = 120): Promise<boolean> {
  tw.command({ type: 'player.move', to });
  return tw.until((x) => dist(player(x).pos, to) < 0.6 && player(x).path.length === 0, maxMinutes);
}

const ECON = [...SIM_FEATURES, 'player', 'economy'] as Feature[];
describe.skipIf(!ready(...ECON))(`§14.1 gold and tasks${waitingFor(...ECON)}`, () => {
  it('pays economy.eventReward when the player attends an event until it is done', async () => {
    w = await createTestWorld({ startAt: '06:00' });
    await w.advanceTo('10:00');
    const gold0 = player(w).gold;
    w.command({ type: 'world.trigger', kind: 'party' });
    await w.advance(1);
    const party = w.state().events.find((e) => e.hostId === PLAYER_ID)!;
    expect(party).toBeDefined();
    const loc = w.location(party.locationId)!;
    expect(await walkTo(w, loc.entry, 60)).toBe(true);
    await w.advanceTo(party.end + 5);
    expect(w.state().events.find((e) => e.id === party.id)!.status).toBe('done');
    expect(player(w).gold).toBe(gold0 + w.config.economy.eventReward);
    expect(w.of('player.updated').length).toBeGreaterThan(0);
  }, 120_000);

  it('pays economy.taskReward when an accepted "ask to do it" block completes', async () => {
    w = await createTestWorld({ startAt: '06:00' });
    await w.advanceTo('09:00');
    const v = w.state().villagers.find(awake)!;
    const gold0 = player(w).gold;
    w.command({
      type: 'player.say',
      villagerId: v.id,
      text: 'Could you go to the park and water the flowers?',
      mode: 'ask',
    });
    const tagged = await w.until((x) => !!x.villager(v.id).plan?.blocks.some((b) => b.taskId), 60);
    expect(tagged).toBe(true);
    const block = w.villager(v.id).plan!.blocks.find((b) => b.taskId)!;
    await w.advanceTo(at(0, '00:00') + block.end + 10);
    expect(player(w).gold).toBe(gold0 + w.config.economy.taskReward);
    expect(w.memories(v.id).some((m) => m.kind === 'event' && /asked/i.test(m.text))).toBe(true);
    expect(w.villager(v.id).relationships[PLAYER_ID]?.affinity ?? 0).toBeGreaterThanOrEqual(1);
  }, 120_000);
});

const BAG = [...SIM_FEATURES, 'player', 'inventory', 'items'] as Feature[];
describe.skipIf(!ready(...BAG))(`§14.1 backpack and gifts${waitingFor(...BAG)}`, () => {
  it('picks up an item by walking onto it, respawns it, and gifts it to a villager', async () => {
    w = await createTestWorld({ startAt: '08:00', config: { economy: { itemRespawnGameMinutes: 30 } } });
    await w.advance(5);
    const items0 = w.state().items;
    expect(items0.length).toBeGreaterThan(0);
    const item = items0[0]!;
    expect(await walkTo(w, item.pos, 120)).toBe(true);
    await w.advance(1);
    expect(count(w, item.itemId)).toBe(1);
    expect(w.state().items.some((i) => i.id === item.id)).toBe(false);
    expect(w.of('items.updated').length).toBeGreaterThan(0);

    await w.advance(60);
    expect(w.state().items.filter((i) => i.itemId === item.itemId).length).toBeGreaterThanOrEqual(
      items0.filter((i) => i.itemId === item.itemId).length,
    );

    const v = w.state().villagers.find(awake)!;
    const mems = w.memories(v.id).length;
    const aff = w.villager(v.id).relationships[PLAYER_ID]?.affinity ?? 0;
    w.command({ type: 'player.gift', villagerId: v.id, itemId: item.itemId });
    await w.until(
      (x) => x.of('conversation.message').some((m) => m.speakerId === v.id && m.listenerId === PLAYER_ID),
      30,
    );
    expect(count(w, item.itemId)).toBe(0);
    expect(w.memories(v.id).length).toBeGreaterThan(mems);
    expect(w.villager(v.id).relationships[PLAYER_ID]?.affinity ?? 0).toBeGreaterThanOrEqual(aff + 1);
    expect(w.of('conversation.message').some((m) => m.speakerId === v.id && m.listenerId === PLAYER_ID)).toBe(
      true,
    );
  }, 120_000);
});

const PET = [...SIM_FEATURES, 'player', 'pet'] as Feature[];
describe.skipIf(!ready(...PET))(`§14.1 pet${waitingFor(...PET)}`, () => {
  it('follows the player within 2 tiles and villagers notice it', async () => {
    w = await createTestWorld({ startAt: '10:00' });
    const square = w.engine.map.locations.find((l) => l.kind === 'public')!;
    w.command({ type: 'player.move', to: square.entry });
    let maxGap = 0;
    await w.until((x) => {
      const p = player(x);
      if (p.path.length === 0) maxGap = Math.max(maxGap, dist(p.pos, p.pet.pos));
      return p.path.length === 0 && dist(p.pos, square.entry) < 0.6;
    }, 120);
    await w.advance(5);
    expect(maxGap).toBeLessThanOrEqual(2.5);
    expect(dist(player(w).pos, player(w).pet.pos)).toBeLessThanOrEqual(2.5);
    await w.advance(120);
    const pet = player(w).pet.name;
    expect(w.state().villagers.some((v) => w!.memories(v.id).some((m) => m.text.includes(pet)))).toBe(true);
  }, 120_000);

  it('stays when told to stay', async () => {
    w = await createTestWorld({ startAt: '10:00' });
    w.command({ type: 'pet.command', action: 'stay' });
    await w.advance(1);
    const spot = { ...player(w).pet.pos };
    const square = w.engine.map.locations.find((l) => l.kind === 'public')!;
    await walkTo(w, square.entry, 120);
    expect(player(w).pet.mode).toBe('stay');
    expect(dist(player(w).pet.pos, spot)).toBeLessThan(1);
  }, 120_000);
});

const DECOR = [...SIM_FEATURES, 'player', 'decor', 'decorations'] as Feature[];
describe.skipIf(!ready(...DECOR))(`§14.1 home decorating${waitingFor(...DECOR)}`, () => {
  const items = () => catalog<DecorationItem>('decorations', 'decorations');

  it('buys once, puts away and places again for free', async () => {
    w = await createTestWorld({ startAt: '09:00' });
    const gold0 = player(w).gold;
    const item = items()
      .filter((i) => i.cost <= gold0)
      .sort((a, b) => a.cost - b.cost)[0]!;
    w.command({ type: 'decor.toggle', itemId: item.id });
    expect(player(w).gold).toBe(gold0 - item.cost);
    expect(player(w).ownedDecorations).toContain(item.id);
    expect(player(w).placedDecorations).toContain(item.id);
    w.command({ type: 'decor.toggle', itemId: item.id });
    expect(player(w).placedDecorations).not.toContain(item.id);
    expect(player(w).gold).toBe(gold0 - item.cost);
    w.command({ type: 'decor.toggle', itemId: item.id });
    expect(player(w).placedDecorations).toContain(item.id);
    expect(player(w).gold).toBe(gold0 - item.cost);
    const updates = w.of('player.updated') as PlayerUpdatedMsg[];
    expect(updates.length).toBeGreaterThanOrEqual(3);
  });

  it('rejects a purchase the player cannot afford', async () => {
    w = await createTestWorld({ startAt: '09:00', config: { economy: { startGold: 0 } } });
    const item = items().find((i) => i.cost > 0)!;
    w.command({ type: 'decor.toggle', itemId: item.id });
    expect(player(w).gold).toBe(0);
    expect(player(w).ownedDecorations).not.toContain(item.id);
    expect(w.of('toast').length + w.of('error').length).toBeGreaterThan(0);
  });

  it("villagers passing the player's home notice new decorations", async () => {
    w = await createTestWorld({ startAt: '06:00', config: { economy: { startGold: 500 } } });
    const placed = items().slice(0, 3);
    for (const i of placed) w.command({ type: 'decor.toggle', itemId: i.id });
    expect(player(w).placedDecorations.length).toBe(placed.length);
    await w.advanceTo('21:00');
    const names = placed.map((i) => i.name.toLowerCase());
    const noticed = w
      .state()
      .villagers.some((v) =>
        w!.memories(v.id).some((m) => names.some((n) => m.text.toLowerCase().includes(n))),
      );
    expect(noticed, `someone passes ${PLAYER_HOME_ID} and notices ${names.join(', ')}`).toBe(true);
  }, 180_000);
});
