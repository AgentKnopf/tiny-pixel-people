import { describe, expect, it } from 'vitest';
import { at } from '../../../src/shared/time.ts';
import type { Conversation } from '../../../src/shared/types.ts';
import { MockChatProvider } from '../../../src/server/llm/providers/mock.ts';
import {
  ask,
  LoadTracker,
  loadTracker,
  LAG_BUSY,
  LAG_OVERLOADED,
} from '../../../src/server/cognition/llm.ts';
import { createConversationRunner } from '../../../src/server/cognition/conversation.ts';
import { parsePlan } from '../../../src/server/cognition/planning.ts';
import { PRIORITY } from '../../../src/server/cognition/mind.ts';
import { createTestVillage, DirectQueue, LOCATIONS, testConfig, type TestVillage } from './helpers.ts';

function convo(v: TestVillage, a: string, b: string, id: string): Conversation {
  return {
    id,
    participants: [a, b],
    locationId: 'plaza',
    startedAt: v.time.now,
    messages: [],
    status: 'active',
  };
}

function tell(v: TestVillage, id: string, text: string): void {
  v.minds
    .get(id)!
    .observe({ at: v.time.now, kind: 'heard', text, importance: 8, meta: { originId: 'fact_9' } });
}

describe('load tracking', () => {
  it('measures lag in game minutes, notices stalled calls and recovers when idle', () => {
    const t = new LoadTracker();
    expect(t.level(0)).toBe('normal');
    for (let i = 0; i < 10; i++) t.finish(t.start(100), 100 + 2 * LAG_OVERLOADED);
    expect(t.level(200)).toBe('overloaded');
    expect(t.level(200 + 3 * 60)).toBe('normal');
    const fresh = new LoadTracker();
    fresh.start(0);
    expect(fresh.level(2 * LAG_BUSY + 1)).toBe('busy');
  });

  it('abandons a call at its game-time deadline and answers offline calls without the model', async () => {
    const p = new MockChatProvider();
    p.setScript('convo.turn', () => new Promise<string>((r) => setTimeout(() => r('{"say":"late"}'), 3_000)));
    const q = new DirectQueue(p);
    let now = 0;
    const spec = {
      task: 'convo.turn' as const,
      system: 's',
      user: 'u',
      parse: () => 'llm',
      fallback: () => 'fallback',
      shape: '{}',
      now: () => now,
    };
    const pending = ask(q, { ...spec, deadline: 20 });
    now = 25;
    const t0 = Date.now();
    expect(await pending).toEqual({ value: 'fallback', source: 'fallback' });
    expect(Date.now() - t0).toBeLessThan(2_000);
    const before = q.requests.length;
    expect((await ask(q, { ...spec, offline: true })).source).toBe('fallback');
    expect(q.requests.length).toBe(before);
  });
});

describe('cheap plans', () => {
  it('parses compact block tuples', () => {
    const p = parsePlan(
      {
        summary: 's',
        blocks: [
          ['07:00', '11:00', 'bakery', 'bake bread'],
          ['11:00', '12:00', 'cafe', 'lunch'],
        ],
      },
      LOCATIONS,
      'house_mia',
    );
    expect(p?.blocks.map((b) => [b.start, b.end, b.locationId, b.activity])).toEqual([
      [420, 660, 'bakery', 'bake bread'],
      [660, 720, 'cafe', 'lunch'],
    ]);
  });

  it("asks for today's late plan ahead of dialogue and tomorrow's at background priority", async () => {
    const p = new MockChatProvider();
    p.setScript('plan.day', () =>
      JSON.stringify({
        summary: 'bake',
        blocks: [
          ['06:30', '12:00', 'bakery', 'bake'],
          ['12:00', '21:00', 'plaza', 'chat'],
        ],
      }),
    );
    const v = createTestVillage({ start: at(0, '05:59'), provider: p });
    await v.advanceTo(at(0, '06:01'));
    expect(PRIORITY.planToday).toBeGreaterThan(100);
    await v.advanceTo(at(0, '20:35'), 5);
    const plans = v.queue.requests.filter((r) => r.task === 'plan.day' && r.meta?.villagerId === 'mia');
    expect(plans.map((r) => r.meta?.day)).toEqual([0, 1]);
    expect(v.queue.priorities.get(plans[0]!)).toBe(PRIORITY.planToday);
    expect(v.queue.priorities.get(plans[1]!)).toBe(PRIORITY.planTomorrow);
  });
});

describe('under load', () => {
  it('skips optional LLM work: importance, reflection, conversation summaries', async () => {
    const v = createTestVillage({ start: at(0, '07:59') });
    await v.advanceTo(at(0, '08:00'));
    await v.queue.drain();
    loadTracker(v.queue).seed(LAG_OVERLOADED * 2, v.time.now);
    const before = v.queue.requests.length;
    const mia = v.minds.get('mia')!;
    for (let i = 0; i < 12; i++)
      mia.observe({ at: v.time.now, kind: 'conversation', text: `Something notable number ${i} happened` });
    await v.advanceTo(at(0, '08:35'));
    const tasks = v.queue.requests.slice(before).map((r) => r.task);
    expect(tasks).not.toContain('importance.rate');
    expect(tasks).not.toContain('reflect');
  });

  it('opens with the news holder, keeps turns short and echoes news with canned lines when overloaded', async () => {
    const p = new MockChatProvider();
    const v = createTestVillage({ start: at(0, '08:00'), provider: p });
    await v.advanceTo(at(0, '08:01'));
    tell(v, 'ben', "The mayor's cat is named Biscuit.");
    loadTracker(v.queue).seed(LAG_OVERLOADED + 10, v.time.now);
    const before = v.queue.requests.length;
    const run = createConversationRunner({
      config: testConfig(),
      queue: v.queue,
      now: () => v.time.now,
      emit: () => {},
    });
    const c = await run.run(convo(v, 'mia', 'ben', 'c1'), [v.minds.get('mia')!, v.minds.get('ben')!]);
    expect(c.messages[0]).toMatchObject({ speakerId: 'ben' });
    expect(c.messages[0]!.text).toContain('Biscuit');
    expect(c.messages[1]).toMatchObject({ speakerId: 'mia' });
    expect(c.messages[1]!.text).toContain('Biscuit');
    expect(c.messages.length).toBeLessThanOrEqual(3);
    expect(v.queue.requests.length).toBe(before);
    expect(
      v.minds
        .get('mia')!
        .memory.all()
        .some((m) => m.kind === 'heard' && m.meta.originId === 'fact_9'),
    ).toBe(true);
  });

  it('adds an echo when the model ignores news it was just told', async () => {
    const p = new MockChatProvider();
    p.setScript('convo.turn', (req) =>
      req.meta?.villagerId === 'ben'
        ? `{"say":"Did you hear? The mayor's cat is named Biscuit.","end":false}`
        : '{"say":"Nice weather today!","end":true}',
    );
    const v = createTestVillage({ start: at(0, '08:00'), provider: p });
    await v.advanceTo(at(0, '08:01'));
    tell(v, 'ben', "The mayor's cat is named Biscuit.");
    const run = createConversationRunner({
      config: testConfig(),
      queue: v.queue,
      now: () => v.time.now,
      emit: () => {},
    });
    const c = await run.run(convo(v, 'ben', 'mia', 'c2'), [v.minds.get('ben')!, v.minds.get('mia')!]);
    expect(c.messages[1]!.text).toMatch(/^Really\? The mayor's cat is named Biscuit\? Nice weather/);
    const turnReq = v.queue.requests.find((r) => r.task === 'convo.turn')!;
    expect(turnReq.maxTokens).toBeLessThanOrEqual(80);
  });

  it('only wants to talk when there is news while overloaded', async () => {
    const v = createTestVillage({ start: at(0, '09:00') });
    await v.advanceTo(at(0, '09:01'));
    loadTracker(v.queue).seed(LAG_OVERLOADED + 10, v.time.now);
    const mia = v.minds.get('mia')!;
    expect([0, 1, 2, 3, 4].some(() => mia.wantsToTalkTo(v.view('mia'), 'dan'))).toBe(false);
    tell(v, 'dan', 'The bridge washed away last night.');
    expect(mia.wantsToTalkTo(v.view('mia'), 'dan')).toBe(true);
  });
});
