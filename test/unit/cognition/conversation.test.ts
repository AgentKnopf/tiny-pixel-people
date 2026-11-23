import { describe, expect, it } from 'vitest';
import { at } from '../../../src/shared/time.ts';
import type { ChatRequest } from '../../../src/server/llm/types.ts';
import type { Conversation, ConversationMessage } from '../../../src/shared/types.ts';
import { MockChatProvider } from '../../../src/server/llm/providers/mock.ts';
import { createConversationRunner } from '../../../src/server/cognition/conversation.ts';
import { createTestVillage, testConfig, type TestVillage } from './helpers.ts';

/** Like the WP6 mock: first own turn shares news item #1 verbatim, ends after 4 messages. */
function turn(req: ChatRequest): string {
  const m = req.meta!;
  const mine = (m.transcript as ConversationMessage[]).filter((x) => x.speakerId === m.villagerId).length;
  const news = m.news as { text: string }[];
  const say =
    mine === 0 && news[0]
      ? `Did you hear? ${news[0].text}`
      : mine === 0
        ? `Hi ${String(m.partnerName)}!`
        : 'Lovely talking to you!';
  return JSON.stringify({ say, end: (m.transcript as unknown[]).length >= 3 });
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

function runner(v: TestVillage) {
  return createConversationRunner({
    config: testConfig(),
    queue: v.queue,
    now: () => v.time.now,
    emit: (m) => v.messages.push(m),
  });
}

describe('conversation runner and gossip', () => {
  it('passes a rumor A → B → C keeping originId, heardFrom, toldTo and hops', async () => {
    const p = new MockChatProvider();
    p.setScript('convo.turn', turn);
    const v = createTestVillage({ start: at(0, '08:00'), provider: p });
    await v.advanceTo(at(0, '08:01'));
    const mia = v.minds.get('mia')!;
    mia.observe({
      at: v.time.now,
      kind: 'heard',
      text: "the newcomer told me: The mayor's cat is named Biscuit.",
      importance: 7,
      meta: { heardFrom: 'player', originId: 'fact_1' },
    });
    const r = runner(v);
    const c1 = await r.run(convo(v, 'mia', 'ben', 'c1'), [mia, v.minds.get('ben')!]);
    expect(c1.status).toBe('ended');
    expect(c1.messages.length).toBe(4);
    expect(c1.messages[0]!.text).toContain('Biscuit');
    const benHeard = v.minds
      .get('ben')!
      .memory.all()
      .find((m) => m.kind === 'heard')!;
    expect(benHeard.meta).toMatchObject({ originId: 'fact_1', heardFrom: 'mia', conversationId: 'c1' });
    expect(mia.memory.all().find((m) => m.meta.originId === 'fact_1')!.meta.toldTo).toEqual(['ben']);
    expect(v.worlds.get('ben')!.learned[0]).toMatchObject({
      from: 'mia',
      to: 'ben',
      originId: 'fact_1',
      conversationId: 'c1',
    });
    expect(v.worlds.get('ben')!.learned[0]!.said).toContain('Biscuit');
    expect(v.worlds.get('ben')!.relationships.mia!.affinity).toBe(1);
    expect(
      v.minds
        .get('ben')!
        .memory.all()
        .some((m) => m.kind === 'conversation' && m.meta.conversationId === 'c1'),
    ).toBe(true);

    v.time.now += 30;
    const c2 = await r.run(convo(v, 'ben', 'cleo', 'c2'), [v.minds.get('ben')!, v.minds.get('cleo')!]);
    expect(c2.messages[0]!.speakerId).toBe('ben');
    expect(c2.messages[0]!.text).toContain('Biscuit');
    expect(
      v.minds
        .get('cleo')!
        .memory.all()
        .find((m) => m.kind === 'heard')!.meta,
    ).toMatchObject({ originId: 'fact_1', heardFrom: 'ben' });

    // Mia does not re-tell Ben, and Ben does not tell it back to Mia.
    expect(mia.newsFor('ben', v.time.now)).toEqual([]);
    expect(v.minds.get('ben')!.newsFor('mia', v.time.now)).toEqual([]);
  });

  it('passes the canonical mock meta keys', async () => {
    const p = new MockChatProvider();
    p.setScript('convo.turn', turn);
    const v = createTestVillage({ start: at(0, '08:00'), provider: p });
    v.minds
      .get('mia')!
      .observe({ at: v.time.now, kind: 'heard', text: 'The bridge is closed', importance: 7 });
    await runner(v).run(convo(v, 'mia', 'ben', 'c0'), [v.minds.get('mia')!, v.minds.get('ben')!]);
    const t = v.queue.requests.find((r) => r.task === 'convo.turn')!.meta!;
    expect(Object.keys(t)).toEqual(
      expect.arrayContaining([
        'villagerId',
        'profile',
        'locations',
        'now',
        'partnerId',
        'partnerName',
        'news',
        'transcript',
      ]),
    );
    expect(t.news).toEqual([{ id: expect.any(String), text: 'The bridge is closed' }]);
    const s = v.queue.requests.find((r) => r.task === 'convo.summarize')!.meta!;
    expect(s.participants).toEqual(['mia', 'ben']);
    expect(s.offered).toEqual([{ id: expect.any(String), text: 'The bridge is closed', by: 'mia' }]);
    expect((s.transcript as unknown[]).length).toBe(4);
  });

  it('respects max turns, accepts plain-text lines and uses fallbacks on failure', async () => {
    const p = new MockChatProvider();
    let n = 0;
    p.setScript('convo.turn', () => `Ben: Line number ${++n} here.`);
    p.setScript('convo.summarize', () => 'not json');
    const v = createTestVillage({
      start: at(0, '08:00'),
      provider: p,
      config: testConfig({ maxConversationTurns: 3 }),
    });
    const c = await createConversationRunner({
      config: testConfig({ maxConversationTurns: 3 }),
      queue: v.queue,
      now: () => v.time.now,
      emit: () => {},
    }).run(convo(v, 'mia', 'ben', 'c3'), [v.minds.get('mia')!, v.minds.get('ben')!]);
    expect(c.messages.map((m) => m.text)).toEqual([
      'Line number 1 here.',
      'Line number 2 here.',
      'Line number 3 here.',
    ]);
    expect(c.messages.map((m) => m.speakerId)).toEqual(['mia', 'ben', 'mia']);
    expect(
      v.minds
        .get('ben')!
        .memory.all()
        .some((m) => m.kind === 'conversation'),
    ).toBe(true);
    expect(v.worlds.get('mia')!.relationships.ben!.affinity).toBe(1);
  });

  it('stops when the engine aborts the conversation', async () => {
    const p = new MockChatProvider();
    const v = createTestVillage({ start: at(0, '08:00'), provider: p });
    const conv = convo(v, 'mia', 'ben', 'c4');
    p.setScript('convo.turn', () => {
      conv.status = 'aborted';
      return '{"say":"hello"}';
    });
    const c = await runner(v).run(conv, [v.minds.get('mia')!, v.minds.get('ben')!]);
    expect(c.status).toBe('aborted');
    expect(c.messages).toEqual([]);
  });

  it('uses learned facts from the summary with fromNewsIndex', async () => {
    const p = new MockChatProvider();
    p.setScript('convo.turn', () => '{"say":"There is something going on at the well.","end":true}');
    p.setScript('convo.summarize', (req) => {
      const offered = req.meta!.offered as { by: string }[];
      const idx = offered.findIndex((o) => o.by === 'mia');
      return JSON.stringify({
        forA: { summary: 'I told Ben', learned: [], affinityDelta: 2 },
        forB: {
          summary: 'Mia told me about the well',
          learned: [{ text: 'The well is haunted', importance: 6, fromNewsIndex: idx }],
          affinityDelta: -1,
        },
      });
    });
    const v = createTestVillage({ start: at(0, '08:00'), provider: p });
    v.minds
      .get('mia')!
      .observe({ at: v.time.now, kind: 'heard', text: 'The old well is haunted at night', importance: 6 });
    const origin = v.minds.get('mia')!.memory.all().at(-1)!.id;
    await runner(v).run(convo(v, 'mia', 'ben', 'c5'), [v.minds.get('mia')!, v.minds.get('ben')!]);
    const heard = v.minds
      .get('ben')!
      .memory.all()
      .find((m) => m.kind === 'heard')!;
    expect(heard).toMatchObject({ importance: 6, meta: { originId: origin, heardFrom: 'mia' } });
    expect(v.worlds.get('mia')!.relationships.ben!.affinity).toBe(2);
    expect(v.worlds.get('ben')!.relationships.mia).toMatchObject({
      affinity: -1,
      summary: 'Mia told me about the well',
    });
  });
});
