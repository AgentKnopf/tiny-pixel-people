import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JsonSaveStore } from '../../src/server/persistence/index.ts';
import { at, minuteOfDay } from '../../src/shared/time.ts';
import type { VillageEvent } from '../../src/shared/types.ts';
import { createSimTestWorld } from '../helpers/sim.ts';

const errorsOf = (messages: { type: string; level?: string }[]) =>
  messages.filter((m) => m.type === 'log' && m.level === 'error');

async function waitFor(pred: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  return pred();
}

describe('sim engine', () => {
  it('runs a full day: villagers follow their plans, chat and sleep', async () => {
    const { engine, messages } = createSimTestWorld({ config: { sim: { villagers: 16 } } });
    let onPlan = 0;
    let samples = 0;
    for (let t = 0; t < 24 * 60; t += 30) {
      await engine.advance(30, { drainLlm: true });
      const m = minuteOfDay(engine.now());
      if (m < 9 * 60 || m > 18 * 60) continue;
      for (const v of engine.snapshot().villagers) {
        const block = v.plan?.blocks.find((b) => b.start <= m && m < b.end);
        if (!block || v.status === 'talking' || v.status === 'walking') continue;
        samples++;
        if (v.locationId === block.locationId) onPlan++;
      }
    }
    expect(errorsOf(messages)).toEqual([]);
    expect(samples).toBeGreaterThan(100);
    expect(onPlan / samples).toBeGreaterThan(0.7);
    expect(engine.conversations().filter((c) => c.status === 'ended').length).toBeGreaterThan(5);
    const lines = messages.filter((m) => m.type === 'conversation.message');
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((m) => m.source === 'fallback')).toBe(true);
    // 06:00 next day: everyone slept at home overnight.
    expect(engine.now()).toBe(at(1, '06:00'));
  }, 60_000);

  it('pause keeps time and positions', async () => {
    const { engine } = createSimTestWorld({ startAt: '10:00' });
    await engine.advance(20);
    engine.setSpeed(0);
    const before = engine.snapshot();
    engine.start();
    await new Promise((r) => setTimeout(r, 200));
    engine.stop();
    const after = engine.snapshot();
    expect(after.time).toBe(before.time);
    expect(after.villagers.map((v) => v.pos)).toEqual(before.villagers.map((v) => v.pos));
  });

  it('owner reads a door note on arriving home and replies; a rumor starts', async () => {
    const { engine, messages } = createSimTestWorld({ startAt: '10:00' });
    const v = engine.snapshot().villagers.find((x) => x.id === 'tom')!;
    const home = engine.profile('tom')!.homeId;
    expect(engine.handleCommand({ type: 'note.post', houseId: home, text: 'Come to the picnic!' })).toEqual(
      [],
    );
    await engine.advance(16 * 60, { drainLlm: true });
    const note = engine.snapshot().notes.find((n) => n.ownerId === v.id)!;
    expect(note.status).toBe('replied');
    expect(note.reply).toBeTruthy();
    expect(note.replySource).toBe('fallback');
    expect(engine.memories('tom').some((m) => m.kind === 'note' && m.text.includes('picnic'))).toBe(true);
    expect(messages.some((m) => m.type === 'note.updated' && m.note.status === 'replied')).toBe(true);
    expect(engine.snapshot().rumors.some((r) => r.text.includes('picnic'))).toBe(true);
  }, 30_000);

  it('event attendance: invited villagers come and remember it', async () => {
    const { engine } = createSimTestWorld({ startAt: '09:00', config: { sim: { villagers: 10 } } });
    const ids = engine.snapshot().villagers.map((v) => v.id);
    const event: VillageEvent = {
      id: 'ev1',
      hostId: ids[0]!,
      title: 'Bake-off',
      description: 'Who bakes the best pie?',
      locationId: 'square',
      start: at(0, '15:00'),
      end: at(0, '16:00'),
      invitees: ids.slice(1),
      accepted: ids.slice(1, 6),
      declined: [],
      attendees: [],
      status: 'scheduled',
    };
    engine.upsertEvent(event);
    await engine.advance(8 * 60, { drainLlm: true });
    const done = engine.snapshot().events.find((e) => e.id === 'ev1')!;
    expect(done.status).toBe('done');
    expect(done.attendees.length).toBeGreaterThanOrEqual(3);
    for (const id of done.attendees) {
      expect(engine.memories(id).some((m) => m.kind === 'event' && m.text.includes('Bake-off'))).toBe(true);
    }
  }, 30_000);

  it('inspect returns state, plan, memories and relationships', async () => {
    const { engine } = createSimTestWorld({ startAt: '08:00' });
    await engine.advance(60, { drainLlm: true });
    const [msg] = engine.handleCommand({ type: 'inspect', villagerId: 'mia', requestId: 'x' });
    expect(msg).toMatchObject({ type: 'inspect.data', villagerId: 'mia' });
    if (msg?.type !== 'inspect.data') throw new Error('no inspect');
    expect(msg.plan?.blocks.length).toBeGreaterThan(3);
    expect(msg.memories.length).toBeGreaterThan(0);
    expect(msg.state.activity.text).toBeTruthy();
    expect(engine.handleCommand({ type: 'inspect', villagerId: 'nobody' })[0]?.type).toBe('error');
  });

  it('player chat: the villager stops, answers on player:<id> and then resumes', async () => {
    const { engine, messages } = createSimTestWorld({ startAt: '10:00' });
    await engine.advance(5);
    const v = engine.snapshot().villagers.find((x) => x.status !== 'sleeping')!;
    expect(
      engine.handleCommand({ type: 'player.say', villagerId: v.id, text: 'Hi there!', mode: 'say' }),
    ).toEqual([]);
    expect(engine.villager(v.id)!.status).toBe('talking');
    await engine.advance(1, { drainLlm: true });
    const reply = messages.find(
      (m) => m.type === 'conversation.message' && m.speakerId === v.id && m.listenerId === 'player',
    );
    expect(reply).toMatchObject({ conversationId: `player:${v.id}` });
    await engine.advance(10, { drainLlm: true });
    expect(engine.villager(v.id)!.status).not.toBe('talking');
    expect(engine.memories(v.id).some((m) => m.text.includes('Hi there!'))).toBe(true);
  });

  it('pairTalk starts a conversation even during cooldowns', async () => {
    const { engine, messages } = createSimTestWorld({ startAt: '10:00' });
    await engine.advance(5);
    const [a, b] = engine.snapshot().villagers.filter((x) => x.status !== 'sleeping');
    expect(engine.handleCommand({ type: 'player.pairTalk', aId: a!.id, bId: b!.id })).toEqual([]);
    await engine.advance(30, { drainLlm: true });
    expect(
      engine.conversations().some((c) => c.participants.includes(a!.id) && c.participants.includes(b!.id)),
    ).toBe(true);
    expect(messages.some((m) => m.type === 'conversation.ended')).toBe(true);
  });

  it('strangers arrive and leave with villagers.changed', async () => {
    const { engine, messages } = createSimTestWorld({ startAt: '10:00' });
    const count = engine.profiles.length;
    expect(engine.handleCommand({ type: 'world.trigger', kind: 'stranger' })).toEqual([]);
    expect(engine.profiles.length).toBe(count + 1);
    const added = messages.find((m) => m.type === 'villagers.changed' && m.added.length > 0);
    expect(added).toBeTruthy();
    await engine.advance(13 * 60, { drainLlm: true });
    expect(engine.profiles.length).toBe(count);
    expect(messages.some((m) => m.type === 'villagers.changed' && m.removed.length > 0)).toBe(true);
  }, 30_000);

  it('villagers notice the pet', async () => {
    const { engine } = createSimTestWorld({ startAt: '07:00' });
    await engine.advance(4 * 60, { drainLlm: true });
    const pet = engine.snapshot().player.pet.name;
    const all = engine.snapshot().villagers.flatMap((v) => engine.memories(v.id));
    // The player starts at home; walk past the bakery so the pet is seen in town.
    if (!all.some((m) => m.text.includes(pet))) {
      const bakery = engine.map.locations.find((l) => l.id === 'square')!;
      engine.handleCommand({ type: 'player.move', to: bakery.entry });
      await engine.advance(60, { drainLlm: true });
    }
    const after = engine.snapshot().villagers.flatMap((v) => engine.memories(v.id));
    expect(after.some((m) => m.text.includes(pet))).toBe(true);
  }, 30_000);

  it('debug.inject stores a heard memory and tracks it as a rumor', () => {
    const { engine } = createSimTestWorld({ startAt: '10:00' });
    expect(
      engine.handleCommand({ type: 'debug.inject', villagerId: 'mia', text: 'The well is haunted' }),
    ).toEqual([]);
    const mem = engine.memories('mia').find((m) => m.text === 'The well is haunted')!;
    expect(mem.kind).toBe('heard');
    const rumor = engine.snapshot().rumors.find((r) => r.text === 'The well is haunted');
    expect(rumor?.originMemoryId ?? mem.meta.originId).toBe(mem.meta.originId);
  });

  it('save command writes the slot and the world restores from it', async () => {
    const { engine } = createSimTestWorld({ startAt: '09:00' });
    await engine.advance(120, { drainLlm: true });
    engine.handleCommand({ type: 'note.post', houseId: engine.profile('sam')!.homeId, text: 'Hello Sam' });
    engine.handleCommand({ type: 'save' });
    const slot = engine.store.slotDir;
    expect(await waitFor(() => existsSync(join(slot, 'world.json')))).toBe(true);
    expect(readdirSync(join(slot, 'memories')).length).toBe(engine.profiles.length);
    await waitFor(() => readFileSync(join(slot, 'replay.jsonl'), 'utf8').includes('note.updated'));
    expect(readFileSync(join(slot, 'replay.jsonl'), 'utf8')).toContain('note.updated');

    const loaded = (await new JsonSaveStore({ dir: join(slot, '..'), slot: 'default' }).load())!;
    const restored = createSimTestWorld({ restore: loaded }).engine;
    const a = engine.snapshot();
    const b = restored.snapshot();
    expect(b.time).toBe(a.time);
    expect(b.player).toEqual(a.player);
    expect(b.notes).toEqual(a.notes);
    const restoredLines = restored.conversations().flatMap((c) => c.messages);
    expect(restoredLines.map((m) => m.source)).toEqual(
      engine.conversations().flatMap((c) => c.messages.map((m) => m.source)),
    );
    expect(b.villagers.map((v) => [v.id, v.pos, v.plan])).toEqual(
      a.villagers.map((v) => [v.id, v.pos, v.plan]),
    );
    for (const v of a.villagers) expect(restored.memories(v.id).length).toBe(engine.memories(v.id).length);
    await restored.advance(60, { drainLlm: true });
  }, 30_000);
});
