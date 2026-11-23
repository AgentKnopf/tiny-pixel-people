import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { askJson, askJsonDetailed, parseJsonLoose } from '../../../src/server/llm/json.ts';
import { MockChatProvider } from '../../../src/server/llm/providers/mock.ts';
import { PriorityLlmQueue } from '../../../src/server/llm/queue.ts';
import type { ChatRequest } from '../../../src/server/llm/types.ts';

describe('parseJsonLoose', () => {
  it.each([
    ['{"a":1}', { a: 1 }],
    ['```json\n{"a": [1, 2]}\n```', { a: [1, 2] }],
    ['Sure! Here is the plan:\n{"a": "x}y"} hope it helps', { a: 'x}y' }],
    ['{"a": 1, "b": [1, 2,],}', { a: 1, b: [1, 2] }],
    ['<think>maybe {"no":1}</think>{"yes": true}', { yes: true }],
    ['[{"x":1}] trailing', [{ x: 1 }]],
    ['{"quote": "she said \\"hi\\" {"}', { quote: 'she said "hi" {' }],
  ])('parses %j', (input, expected) => {
    expect(parseJsonLoose(input)).toEqual(expected);
  });

  it('returns undefined for text without JSON', () => {
    expect(parseJsonLoose('no json here')).toBeUndefined();
    expect(parseJsonLoose('{"broken": ')).toBeUndefined();
  });
});

const schema = z.object({ reply: z.string().min(1) });
const req: ChatRequest = { task: 'note.reply', messages: [{ role: 'user', content: 'Reply in JSON.' }] };

describe('askJson', () => {
  it('validates the first answer and sets json: true', async () => {
    const mock = new MockChatProvider();
    let seen: ChatRequest | undefined;
    mock.setScript('note.reply', (r) => {
      seen = r;
      return 'Here you go: {"reply": "Thanks!"}';
    });
    const out = await askJsonDetailed(new PriorityLlmQueue({ chat: mock }), req, schema, {
      reply: 'fallback',
    });
    expect(out).toMatchObject({ value: { reply: 'Thanks!' }, source: 'llm' });
    expect(seen?.json).toBe(true);
  });

  it('does one repair round with the schema and the bad answer', async () => {
    const mock = new MockChatProvider();
    const seen: ChatRequest[] = [];
    mock.setScript('note.reply', (r) => {
      seen.push(r);
      return seen.length === 1 ? '{"answer": "wrong key"}' : '{"reply": "fixed"}';
    });
    const value = await askJson(new PriorityLlmQueue({ chat: mock }), req, schema, { reply: 'fallback' });
    expect(value).toEqual({ reply: 'fixed' });
    const repair = seen[1]!.messages;
    expect(repair.at(-2)).toEqual({ role: 'assistant', content: '{"answer": "wrong key"}' });
    expect(repair.at(-1)!.content).toContain('"reply"');
  });

  it('falls back after a failed repair or a provider error', async () => {
    const mock = new MockChatProvider();
    mock.setScript('note.reply', () => 'still not json');
    const q = new PriorityLlmQueue({ chat: mock });
    expect(await askJsonDetailed(q, req, schema, () => ({ reply: 'fb' }))).toMatchObject({
      value: { reply: 'fb' },
      source: 'fallback',
    });
    mock.setScript('note.reply', () => {
      throw new Error('down');
    });
    expect(await askJson(q, req, schema, { reply: 'fb2' })).toEqual({ reply: 'fb2' });
  });
});
