import { describe, expect, it } from 'vitest';
import { at } from '../../../src/shared/time.ts';
import type { ChatRequest } from '../../../src/server/llm/types.ts';
import type { DoorNote, VillagerProfile } from '../../../src/shared/types.ts';
import { MockChatProvider } from '../../../src/server/llm/providers/mock.ts';
import { fallbackStats, loadTracker } from '../../../src/server/cognition/llm.ts';
import { PRIORITY } from '../../../src/server/cognition/mind.ts';
import { createTestVillage } from './helpers.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function compactPlan(req: ChatRequest): string {
  const p = req.meta?.profile as VillagerProfile;
  return JSON.stringify({
    summary: `${p.name} works`,
    blocks: [
      ['06:00', '12:00', 'plaza', 'work'],
      ['12:00', '22:00', 'cafe', 'relax'],
    ],
  });
}

describe('morning plans', () => {
  it('has every villager on a model plan before waking on a new world', async () => {
    const p = new MockChatProvider();
    p.setScript('plan.day', compactPlan);
    const v = createTestVillage({ start: at(0, '05:00'), provider: p });
    await v.advanceTo(at(0, '05:10'));
    for (const id of ['mia', 'ben', 'cleo', 'dan']) {
      const plan = v.worlds.get(id)!.plan;
      expect(plan, id).toMatchObject({ day: 0, source: 'llm' });
    }
    const req = v.queue.requests.find((r) => r.task === 'plan.day')!;
    expect(v.queue.priorities.get(req)).toBe(PRIORITY.planToday);
  });

  it('retries an unusable plan answer at once, without waiting for game time', async () => {
    const p = new MockChatProvider();
    const tries = new Map<string, number>();
    p.setScript('plan.day', (req) => {
      const id = String(req.meta?.villagerId);
      tries.set(id, (tries.get(id) ?? 0) + 1);
      return tries.get(id) === 1 ? 'sorry, no idea' : compactPlan(req);
    });
    const v = createTestVillage({ start: at(0, '05:00'), provider: p });
    v.time.now += 1;
    const mia = v.minds.get('mia')!;
    mia.update(v.view('mia'));
    expect(mia.isPlanSettled(0)).toBe(false);
    for (let i = 0; i < 5; i++) await v.queue.drain();
    expect(tries.get('mia')).toBe(2);
    expect(v.worlds.get('mia')!.plan).toMatchObject({ day: 0, source: 'llm' });
    expect(mia.isPlanSettled(0)).toBe(true);
    expect(mia.isPlanSettled(1)).toBe(false);
  });

  it('is not settled on a fresh world until the plan is final, however slow the model', async () => {
    const p = new MockChatProvider();
    let answer: (() => void) | null = null;
    p.setScript(
      'plan.day',
      (req) =>
        new Promise<string>((resolve) => {
          answer = () => resolve(compactPlan(req));
        }),
    );
    const v = createTestVillage({ start: at(0, '05:00'), provider: p });
    const mia = v.minds.get('mia')!;
    expect(mia.isPlanSettled(0)).toBe(false);
    v.time.now += 1;
    mia.update(v.view('mia'));
    await sleep(50);
    expect(v.queue.count('plan.day')).toBe(1);
    expect(mia.isPlanSettled(0)).toBe(false);
    answer!();
    for (let i = 0; i < 5; i++) await sleep(10);
    expect(mia.isPlanSettled(0)).toBe(true);
    expect(v.worlds.get('mia')!.plan).toMatchObject({ day: 0, source: 'llm' });
  });

  it('counts a plan as settled once the model has failed twice', async () => {
    const p = new MockChatProvider();
    p.setScript('plan.day', () => {
      throw new Error('model down');
    });
    const v = createTestVillage({ start: at(0, '05:00'), provider: p });
    v.time.now += 1;
    const mia = v.minds.get('mia')!;
    mia.update(v.view('mia'));
    for (let i = 0; i < 5; i++) await v.queue.drain();
    expect(v.queue.count('plan.day')).toBeGreaterThanOrEqual(2);
    expect(mia.isPlanSettled(0)).toBe(true);
  });
});

describe('provenance', () => {
  it('asks the model for the daily event even when overloaded, and marks the event', async () => {
    const p = new MockChatProvider();
    p.setScript('event.propose', () =>
      JSON.stringify({ title: 'Picnic', location: 'park', start: '15:00', invitees: ['Ben'] }),
    );
    const v = createTestVillage({ start: at(0, '06:50'), provider: p });
    await v.advanceTo(at(0, '06:59'));
    loadTracker(v.queue).seed(1e12, v.time.now);
    await v.advanceTo(at(0, '07:10'));
    expect(v.queue.count('event.propose')).toBe(1);
    const req = v.queue.requests.find((r) => r.task === 'event.propose')!;
    expect(v.queue.priorities.get(req)).toBe(PRIORITY.eventPropose);
    expect(v.events).toHaveLength(1);
    expect(v.events[0]!.source).toBe('llm');
    expect(fallbackStats(v.queue)['event.propose']).toEqual({ llm: 1, fallback: 0 });
  });

  it('marks a fallback event when the model fails', async () => {
    const p = new MockChatProvider();
    p.setScript('event.propose', () => 'no');
    const v = createTestVillage({ start: at(0, '06:50'), provider: p });
    await v.advanceTo(at(0, '07:10'));
    expect(v.events).toHaveLength(1);
    expect(v.events[0]!.source).toBe('fallback');
    expect(fallbackStats(v.queue)['event.propose']).toEqual({ llm: 0, fallback: 1 });
  });

  it.each([
    ['Of course, one blueberry pie coming up!', 'llm'],
    ['Sure thing, see you soon!', 'fallback'],
  ])('sets replySource on note replies (%s)', async (reply, source) => {
    const p = new MockChatProvider();
    p.setScript('note.reply', () => reply);
    const v = createTestVillage({ start: at(0, '17:00'), provider: p });
    const note: DoorNote = {
      id: 'note1',
      houseId: 'house_mia',
      ownerId: 'mia',
      authorId: 'player',
      text: 'Could you bake a blueberry pie for the festival?',
      postedAt: v.time.now,
      status: 'unread',
    };
    v.notes.push(note);
    await v.advanceTo(at(0, '18:05'));
    expect(v.notes[0]).toMatchObject({ status: 'replied', replySource: source });
    expect(v.notes[0]!.reply).toMatch(/blueberry pie/);
  });
});
