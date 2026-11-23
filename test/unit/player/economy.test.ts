import { describe, expect, it } from 'vitest';
import { at } from '../../../src/shared/time.ts';
import { PLAYER_ID, type VillageEvent } from '../../../src/shared/types.ts';
import { advance, setup, villager } from './fake-host.ts';

function event(over: Partial<VillageEvent> = {}): VillageEvent {
  return {
    id: 'ev1',
    title: 'Bake-off',
    description: '',
    hostId: 'ada',
    locationId: 'square',
    start: at(0, '09:00'),
    end: at(0, '10:00'),
    invitees: [],
    accepted: [],
    declined: [],
    attendees: [],
    status: 'scheduled',
    ...over,
  };
}

describe('economy: gold', () => {
  it('pays eventReward when the player attends at least half of an event', () => {
    const { host, pw } = setup();
    const ev = event();
    host.events.push(ev);
    pw.update(1);
    ev.status = 'happening';
    pw.handleCommand({ type: 'player.move', to: { x: 14, y: 9 } });
    advance(host, pw, 60);
    ev.status = 'done';
    advance(host, pw, 1);
    expect(pw.state.gold).toBe(60);
    expect(host.of('toast').some((t) => t.text.includes('+10 gold'))).toBe(true);
    advance(host, pw, 5);
    expect(pw.state.gold).toBe(60);
  });

  it('pays nothing when the player stayed away', () => {
    const { host, pw } = setup();
    const ev = event();
    host.events.push(ev);
    pw.update(1);
    ev.status = 'happening';
    advance(host, pw, 60);
    ev.status = 'done';
    advance(host, pw, 1);
    expect(pw.state.gold).toBe(50);
  });

  it('does not pay for events that were already done when loaded', () => {
    const { host, pw } = setup();
    host.events.push(event({ status: 'done' }));
    advance(host, pw, 2);
    expect(pw.state.gold).toBe(50);
  });

  it('pays taskReward once per completed task, with memory and affinity', () => {
    const { host, pw } = setup();
    const block = {
      start: 600,
      end: 660,
      locationId: 'park',
      activity: 'pick flowers for Kai',
      taskId: 't1',
      done: true,
    };
    pw.onTaskCompleted('ben', 't1', block);
    pw.onTaskCompleted('ben', 't1', block);
    expect(pw.state.gold).toBe(62);
    expect(host.memoriesOf('ben')).toEqual([
      expect.objectContaining({ kind: 'event', text: 'I did what Kai asked: pick flowers for Kai' }),
    ]);
    expect(host.states.find((v) => v.id === 'ben')!.relationships[PLAYER_ID]!.affinity).toBe(1);
  });

  it('falls back to watching task blocks in plans, and skips ones done before load', () => {
    const { host, pw } = setup();
    const ben = host.states.find((v) => v.id === 'ben')!;
    ben.plan = {
      day: 0,
      summary: '',
      revision: 1,
      source: 'llm',
      createdAt: 0,
      blocks: [
        { start: 480, end: 540, locationId: 'park', activity: 'old task', taskId: 'old', done: true },
        { start: 600, end: 660, locationId: 'park', activity: 'water plants', taskId: 'new' },
      ],
    };
    pw.update(1);
    expect(pw.state.gold).toBe(50);
    ben.plan.blocks[1]!.done = true;
    pw.update(1);
    expect(pw.state.gold).toBe(62);
    pw.onTaskCompleted('ben', 'new', ben.plan.blocks[1]!);
    expect(pw.state.gold).toBe(62);
  });
});

describe('decorating', () => {
  it('buys once, puts away and re-places for free', () => {
    const { host, pw } = setup();
    expect(pw.toggleDecoration('string_lights')).toEqual({ ok: true });
    expect(pw.state.gold).toBe(35);
    expect(pw.state.ownedDecorations).toEqual(['string_lights']);
    expect(pw.state.placedDecorations).toEqual(['string_lights']);
    expect(host.of('toast').at(-1)!.text).toBe('String lights placed at your cottage ✓');
    pw.toggleDecoration('string_lights');
    expect(pw.state.placedDecorations).toEqual([]);
    pw.toggleDecoration('string_lights');
    expect(pw.state.placedDecorations).toEqual(['string_lights']);
    expect(pw.state.gold).toBe(35);
    expect(host.of('player.updated').at(-1)!.player.placedDecorations).toEqual(['string_lights']);
  });

  it('rejects a purchase without enough gold', () => {
    const { pw } = setup();
    pw.addGold(-45, 'test');
    const res = pw.handleCommand({ type: 'decor.toggle', itemId: 'string_lights' });
    expect(res?.[0]).toMatchObject({ type: 'error', message: expect.stringContaining('Not enough gold') });
    expect(pw.state.ownedDecorations).toEqual([]);
    expect(pw.state.gold).toBe(5);
  });

  it('villagers passing the cottage notice new decorations once', () => {
    const { host, pw } = setup();
    pw.toggleDecoration('mailbox');
    pw.toggleDecoration('flag');
    host.states.push(villager('eve', { x: 8, y: 16 }));
    advance(host, pw, 3);
    const seen = host.memoriesOf('eve');
    expect(seen).toEqual([
      expect.objectContaining({
        kind: 'observation',
        importance: 3,
        text: "Kai's cottage has new mailbox and flag",
      }),
    ]);
    expect(host.memoriesOf('ada')).toEqual([]);
    expect(pw.mailboxPlaced()).toBe(true);
  });
});
