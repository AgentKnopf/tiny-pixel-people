import { describe, expect, it } from 'vitest';
import { LlmError } from '../../src/server/llm/errors.ts';
import { MockChatProvider, MockEmbeddingProvider, mockAnswer } from '../../src/server/llm/providers/mock.ts';
import type { ChatRequest, LlmTask } from '../../src/server/llm/types.ts';
import type { Location, VillagerProfile } from '../../src/shared/types.ts';
import { parseClock } from '../../src/shared/time.ts';

const loc = (id: string, kind: Location['kind']): Location => ({
  id,
  name: id,
  kind,
  area: { x: 0, y: 0, w: 2, h: 2 },
  entry: { x: 0, y: 0 },
});
const LOCATIONS = [
  loc('house_01', 'house'),
  loc('bakery', 'shop'),
  loc('shop', 'shop'),
  loc('square', 'public'),
  loc('farm', 'nature'),
  loc('park', 'nature'),
];
const BAKER: VillagerProfile = {
  id: 'mia',
  name: 'Mia',
  age: 34,
  occupation: 'baker',
  bio: 'Mia runs the bakery and loves contests.',
  traits: ['warm'],
  homeId: 'house_01',
  sprite: 'characters/mia.png',
  wakeTime: '06:00',
  sleepTime: '22:00',
};

const ask = (task: LlmTask, meta: Record<string, unknown>) =>
  JSON.parse(mockAnswer({ task, messages: [], meta } as ChatRequest)) as Record<string, unknown>;

type Block = {
  start: string;
  end: string;
  location: string;
  activity: string;
  emoji: string;
  eventId?: string;
};

describe('mock provider: provider behaviour', () => {
  it('returns JSON per task and supports scripted answers', async () => {
    const p = new MockChatProvider('mock-model');
    const r = await p.chat({ task: 'event.decide', messages: [{ role: 'user', content: 'x' }] });
    expect(JSON.parse(r.text)).toMatchObject({ accept: true });
    expect(r.model).toBe('mock-model');
    expect(r.usage?.outputTokens).toBeGreaterThan(0);
    p.setScript('note.reply', () => JSON.stringify({ reply: 'scripted' }));
    expect(JSON.parse((await p.chat({ task: 'note.reply', messages: [] })).text)).toEqual({
      reply: 'scripted',
    });
    p.setScript('note.reply', null);
    expect(JSON.parse((await p.chat({ task: 'note.reply', messages: [] })).text)).toHaveProperty('reply');
  });

  it('answers every task with valid JSON, even without meta', () => {
    const tasks: LlmTask[] = [
      'importance.rate',
      'plan.day',
      'plan.revise',
      'convo.turn',
      'convo.summarize',
      'reflect',
      'reflect.questions',
      'event.propose',
      'event.decide',
      'note.reply',
      'day.summarize',
      'player.reply',
      'task.decide',
      'stranger.create',
      'health',
    ];
    for (const task of tasks)
      expect(() => JSON.parse(mockAnswer({ task, messages: [] })), task).not.toThrow();
  });

  it('records calls and injects failures and latency', async () => {
    const p = new MockChatProvider();
    p.failNext('plan.day', 2);
    await expect(p.chat({ task: 'plan.day', messages: [] })).rejects.toBeInstanceOf(LlmError);
    await expect(p.chat({ task: 'plan.day', messages: [] })).rejects.toMatchObject({ retryable: true });
    await expect(p.chat({ task: 'plan.day', messages: [] })).resolves.toBeDefined();
    p.failNext('*', 1, () => new LlmError('http', 'boom', { status: 500, retryable: true }));
    await expect(p.chat({ task: 'convo.turn', messages: [] })).rejects.toMatchObject({ status: 500 });
    p.setLatency(30);
    const t0 = Date.now();
    await p.chat({ task: 'health', messages: [], meta: { villagerId: 'x' } });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
    expect(p.callCount('plan.day')).toBe(3);
    expect(p.callCount()).toBe(5);
    expect(p.calls.at(-1)).toMatchObject({ task: 'health', meta: { villagerId: 'x' }, seq: 4 });
    p.reset();
    expect(p.callCount()).toBe(0);
  });

  it('is deterministic', () => {
    const meta = { villagerId: 'mia', profile: BAKER, locations: LOCATIONS };
    expect(mockAnswer({ task: 'plan.day', messages: [], meta })).toBe(
      mockAnswer({ task: 'plan.day', messages: [], meta }),
    );
  });

  it('produces deterministic unit-length embeddings', async () => {
    const e = new MockEmbeddingProvider();
    const [a, b, c] = await e.embed([
      'the bakery smells nice',
      'the bakery smells nice',
      'gold coins in the well',
    ]);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(Math.hypot(...a!)).toBeCloseTo(1);
  });
});

describe('mock provider: per-task answers (spec §13)', () => {
  it('plan.day: 5-8 ordered, non-overlapping blocks between wake and sleep at known locations', () => {
    const { blocks, summary } = ask('plan.day', {
      villagerId: 'mia',
      profile: BAKER,
      locations: LOCATIONS,
    }) as {
      blocks: Block[];
      summary: string;
    };
    expect(summary).toBeTruthy();
    expect(blocks.length).toBeGreaterThanOrEqual(5);
    expect(blocks.length).toBeLessThanOrEqual(8);
    expect(blocks[0]!.start).toBe('06:00');
    expect(blocks.at(-1)!.end).toBe('22:00');
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i]!;
      expect(LOCATIONS.map((l) => l.id)).toContain(b.location);
      expect(parseClock(b.end)).toBeGreaterThan(parseClock(b.start));
      if (i > 0) expect(b.start).toBe(blocks[i - 1]!.end);
    }
    expect(blocks.some((b) => b.location === 'bakery')).toBe(true);
    expect(blocks.some((b) => b.location === 'square')).toBe(true);
    expect(blocks[0]!.location).toBe('house_01');
  });

  it('plan.day / plan.revise: accepted events become blocks', () => {
    const event = { id: 'ev1', title: 'Bake-off', locationId: 'square', start: 15 * 60, end: 17 * 60 };
    const { blocks } = ask('plan.day', { profile: BAKER, locations: LOCATIONS, acceptedEvents: [event] }) as {
      blocks: Block[];
    };
    const ev = blocks.find((b) => b.eventId === 'ev1')!;
    expect(ev).toMatchObject({ start: '15:00', end: '17:00', location: 'square' });
    for (const b of blocks)
      if (b !== ev) expect(parseClock(b.end) <= 900 || parseClock(b.start) >= 1020, b.activity).toBe(true);
    const plan = {
      summary: 's',
      blocks: [{ start: 360, end: 1320, locationId: 'house_01', activity: 'Home' }],
    };
    const revised = ask('plan.revise', { now: 600, plan, acceptedEvents: [event], locations: LOCATIONS }) as {
      blocks: Block[];
    };
    expect(revised.blocks.map((b) => [b.start, b.end, b.location])).toEqual([
      ['10:00', '15:00', 'house_01'],
      ['15:00', '17:00', 'square'],
      ['17:00', '22:00', 'house_01'],
    ]);
  });

  it('convo.turn: first turn says news #1 verbatim, ends after 4 turns', () => {
    const news = [{ id: 'm1', text: "The mayor's cat is named Biscuit." }];
    const t1 = ask('convo.turn', { villagerId: 'a', partnerName: 'Bo', news, transcript: [] });
    expect(t1).toEqual({ say: "Did you hear? The mayor's cat is named Biscuit.", end: false });
    const t2 = ask('convo.turn', {
      villagerId: 'b',
      partnerName: 'Al',
      news: [],
      transcript: [{ speakerId: 'a', text: 'x' }],
    });
    expect(t2.say).toContain('Al');
    const transcript = [
      { speakerId: 'a', text: 'x' },
      { speakerId: 'b', text: 'y' },
      { speakerId: 'a', text: 'z' },
    ];
    const t4 = ask('convo.turn', { villagerId: 'b', news: [], transcript });
    expect(t4.end).toBe(true);
    expect(t4.say).not.toContain('Biscuit');
  });

  it('convo.summarize: each side learns the news the other actually said, with fromNewsIndex', () => {
    const offered = [
      { id: 'm1', text: "The mayor's cat is named Biscuit.", by: 'a' },
      { id: 'm2', text: 'The bakery opens late tomorrow.', by: 'b' },
      { id: 'm3', text: 'Never mentioned.', by: 'a' },
    ];
    const transcript = [
      { speakerId: 'a', text: "Did you hear? The mayor's cat is named Biscuit." },
      { speakerId: 'b', text: 'Did you hear? The bakery opens late tomorrow.' },
    ];
    const s = ask('convo.summarize', {
      participants: ['a', 'b'],
      offered,
      transcript,
      names: { a: 'Al', b: 'Bo' },
    }) as {
      forA: { learned: { text: string; fromNewsIndex: number }[]; affinityDelta: number; summary: string };
      forB: { learned: { text: string; fromNewsIndex: number }[] };
    };
    expect(s.forB.learned).toEqual([
      { text: "The mayor's cat is named Biscuit.", importance: 5, fromNewsIndex: 0 },
    ]);
    expect(s.forA.learned.map((l) => l.fromNewsIndex)).toEqual([1]);
    expect(s.forA.summary).toContain('Bo');
    expect(s.forA.affinityDelta).toBe(1);
  });

  it('event.propose: bake-off at the square at 15:00 inviting 5 others', () => {
    const villagers = ['mia', 'al', 'bo', 'cy', 'di', 'ed', 'fy'].map((id, i) => ({
      id,
      name: id.toUpperCase(),
      affinity: i,
    }));
    const e = ask('event.propose', {
      villagerId: 'mia',
      profile: BAKER,
      locations: LOCATIONS,
      now: 600,
      villagers,
    });
    expect(e).toMatchObject({ title: 'Bake-off', location: 'square', start: '15:00', durationMinutes: 120 });
    expect(e.invitees).toEqual(['FY', 'ED', 'DI', 'CY', 'BO']);
    const late = ask('event.propose', {
      villagerId: 'mia',
      profile: BAKER,
      locations: LOCATIONS,
      now: 16 * 60,
    });
    expect(late.start).toBe('17:30');
  });

  it('event.decide: accepts when affinity >= 0', () => {
    expect(ask('event.decide', { affinity: 0 }).accept).toBe(true);
    expect(ask('event.decide', { affinity: -1 }).accept).toBe(false);
  });

  it('note.reply: references the note content', () => {
    const r = ask('note.reply', { noteText: 'Could you water the sunflowers by the fountain tomorrow?' });
    expect(r.reply).toContain("'Could you water the sunflowers by'");
  });

  it('importance.rate: kind heuristic per memory', () => {
    const r = ask('importance.rate', {
      memories: [
        { kind: 'note', text: '' },
        { kind: 'observation', text: '' },
        { kind: 'heard', text: '' },
      ],
    });
    expect(r.ratings).toEqual([8, 2, 5]);
  });

  it('reflect: one insight citing memory 1', () => {
    const r = ask('reflect', { memories: [{ text: 'I baked bread with Bo.' }] }) as {
      insights: { text: string; because: number[] }[];
    };
    expect(r.insights).toHaveLength(1);
    expect(r.insights[0]!.because).toEqual([1]);
    expect(r.insights[0]!.text).toContain('baked bread');
  });

  it('player.reply / task.decide: reference the request', () => {
    expect(ask('player.reply', { text: 'I love your bread!' }).reply).toContain('I love your bread!');
    expect(ask('player.reply', { text: 'hi', canLeaveNote: true }).leaveNote).toBeTruthy();
    const t = ask('task.decide', {
      text: 'Please water the flowers in the park',
      locations: LOCATIONS,
      now: 600,
      profile: BAKER,
    });
    expect(t).toMatchObject({ accept: true, location: 'park', time: '10:30' });
  });

  it('stranger.create and day.summarize return usable content', () => {
    expect(ask('stranger.create', {})).toMatchObject({
      name: expect.any(String),
      bio: expect.any(String),
      news: expect.any(String),
    });
    expect(ask('day.summarize', { memories: [{ text: 'I baked bread.' }] }).summary).toContain('baked bread');
  });
});
