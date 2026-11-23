import { describe, expect, it } from 'vitest';
import { at } from '../../../src/shared/time.ts';
import type { Conversation } from '../../../src/shared/types.ts';
import { MockChatProvider } from '../../../src/server/llm/providers/mock.ts';
import { createConversationRunner } from '../../../src/server/cognition/conversation.ts';
import { createTestVillage, testConfig, type TestVillage } from './helpers.ts';

const FACT = "The mayor's cat is named Biscuit.";

function tell(v: TestVillage, id: string): void {
  v.minds
    .get(id)!
    .observe({ at: v.time.now, kind: 'heard', text: FACT, importance: 8, meta: { originId: 'fact_9' } });
}

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

const runner = (v: TestVillage, minutes = 60) =>
  createConversationRunner({
    // Internal knob (not in the config schema); settingsFromConfig spreads cognition config over it.
    config: testConfig({ maxConversationGameMinutes: minutes } as Parameters<typeof testConfig>[0]),
    queue: v.queue,
    now: () => v.time.now,
    emit: () => {},
  });

describe('spreading news on a slow model', () => {
  it('walks up to someone who has not heard fresh news, and stops once it has spread', async () => {
    const v = createTestVillage({ start: at(0, '09:59') });
    await v.advanceTo(at(0, '10:00'));
    const mia = v.minds.get('mia')!;
    expect(mia.update(v.view('mia')).type).not.toBe('talk');
    tell(v, 'mia');
    // Cleo already heard it elsewhere: not worth the walk.
    tell(v, 'cleo');
    v.time.now += 1;
    const intent = mia.update(v.view('mia'));
    expect(intent).toMatchObject({ type: 'talk' });
    const target = (intent as { targetId: string }).targetId;
    expect(['ben', 'dan']).toContain(target);
    // Not again right away.
    v.time.now += 1;
    expect(mia.update(v.view('mia')).type).not.toBe('talk');
    // Told two villagers: no more seeking.
    const m = mia.memory.all().find((x) => x.meta.originId === 'fact_9')!;
    m.meta.toldTo = ['ben', 'dan'];
    v.time.now += 60;
    expect(mia.update(v.view('mia')).type).not.toBe('talk');
  });

  it('adds the listener reaction when a chat is cut off right after the news', async () => {
    const p = new MockChatProvider();
    const v = createTestVillage({ start: at(0, '10:00'), provider: p });
    await v.advanceTo(at(0, '10:01'));
    tell(v, 'ben');
    p.setScript('convo.turn', () => {
      v.time.now += 30;
      return `{"say":"Did you hear? ${FACT}","end":false}`;
    });
    const c = await runner(v, 20).run(convo(v, 'mia', 'ben', 'c1'), [
      v.minds.get('mia')!,
      v.minds.get('ben')!,
    ]);
    expect(c.messages).toHaveLength(2);
    expect(c.messages[0]).toMatchObject({ speakerId: 'ben', source: 'llm' });
    expect(c.messages[1]).toMatchObject({ speakerId: 'mia', source: 'fallback' });
    expect(c.messages[1]!.text).toContain('Biscuit');
  });

  it('records who was told before the conversation summary comes back', async () => {
    const p = new MockChatProvider();
    const v = createTestVillage({ start: at(0, '10:00'), provider: p });
    await v.advanceTo(at(0, '10:01'));
    tell(v, 'ben');
    p.setScript('convo.turn', (req) =>
      req.meta?.villagerId === 'ben'
        ? `{"say":"Did you hear? ${FACT}","end":false}`
        : '{"say":"Really? Biscuit? How funny.","end":true}',
    );
    p.setScript('convo.summarize', () => new Promise<string>(() => {}));
    void runner(v).run(convo(v, 'ben', 'mia', 'c2'), [v.minds.get('ben')!, v.minds.get('mia')!]);
    await new Promise((r) => setTimeout(r, 100));
    const m = v.minds
      .get('ben')!
      .memory.all()
      .find((x) => x.meta.originId === 'fact_9')!;
    expect(m.meta.toldTo).toContain('mia');
    expect(
      v.minds
        .get('ben')!
        .newsFor('mia', v.time.now)
        .some((x) => x.meta.originId === 'fact_9'),
    ).toBe(false);
  });
});
