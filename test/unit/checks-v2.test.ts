/** Self-test of the v2 live checks (test/helpers/checks-v2.ts) and SKIP handling in reports. */
import { describe, expect, it } from 'vitest';
import { PLAYER_ID, type Letter, type Romance, type VisitorInfo } from '../../src/shared/types.ts';
import { formatReport } from '../helpers/checks.ts';
import {
  checkButcherToasts,
  checkDates,
  checkKeep,
  checkLetter,
  checkVisitors,
} from '../helpers/checks-v2.ts';

const visitor = (id: string, over: Partial<VisitorInfo> = {}): VisitorInfo => ({
  villagerId: id,
  arrivedAt: 600,
  departsAt: 2400,
  roomId: 'r1',
  origin: 'the city',
  status: 'checkedIn',
  source: 'llm',
  ...over,
});
const letter = (over: Partial<Letter>): Letter => ({
  id: 'l1',
  from: PLAYER_ID,
  to: 'mia',
  text: 'Would you bake a lemon cake for the picnic?',
  postedAt: 540,
  status: 'replied',
  ...over,
});

describe('v2 live checks', () => {
  it('checkVisitors counts distinct checked-in visitors and their provenance', () => {
    const r = checkVisitors([visitor('a'), visitor('a'), visitor('b', { source: 'fallback' })], 2, true);
    expect(r).toMatchObject({ id: 'AC12', pass: true });
    expect(r.via?.via).toBe('mixed');
    expect(checkVisitors([visitor('a', { roomId: null, status: 'arriving' })], 1, true).pass).toBe(false);
    expect(checkVisitors([], 2, false)).toMatchObject({ skipped: true });
    expect(checkVisitors([], 2, true)).toMatchObject({ pass: false });
  });

  it('checkLetter needs delivery, reading and a reply that shares a keyword', () => {
    const mine = letter({ deliveredAt: 660, readAt: 700 });
    const reply = letter({
      id: 'l2',
      from: 'mia',
      to: PLAYER_ID,
      replyTo: 'l1',
      text: 'A lemon cake? Of course!',
      source: 'llm',
    });
    const ok = checkLetter([mine, reply], mine.text, 'mia');
    expect(ok).toMatchObject({ id: 'AC20', pass: true });
    expect(ok.via?.via).toBe('llm');
    expect(checkLetter([mine, { ...reply, text: 'Thanks!' }], mine.text, 'mia').detail).toContain(
      'shares no keyword',
    );
    expect(checkLetter([letter({})], mine.text, 'mia').detail).toMatch(
      /never delivered.*never read.*no reply/,
    );
    expect(checkLetter([], mine.text, null).pass).toBe(false);
  });

  it('checkKeep finds the logged items newest first', () => {
    const e = (refId: string, at: number) => ({
      id: refId + at,
      kind: 'note' as const,
      at,
      refId,
      authorId: PLAYER_ID,
      text: '',
    });
    const data = { type: 'keep.data' as const, entries: [e('l1', 700), e('n1', 600)], total: 2, offset: 0 };
    expect(checkKeep(data, ['n1', 'l1']).pass).toBe(true);
    expect(checkKeep({ ...data, entries: [...data.entries].reverse() }, ['n1']).detail).toContain(
      'newest first',
    );
    expect(checkKeep(data, ['zz']).detail).toContain('missing zz');
    expect(checkKeep(undefined, ['n1'], 'not inside').detail).toContain('not inside');
  });

  it('checkButcherToasts rejects graphic words and skips when no trip happened', () => {
    expect(
      checkButcherToasts([{ text: '🍔 Tom took a cow to the butcher. Fresh burgers at the Burger Joint!' }])
        .pass,
    ).toBe(true);
    expect(checkButcherToasts([{ text: 'The cow was killed at the butcher' }]).pass).toBe(false);
    expect(checkButcherToasts([{ text: 'Sunny day' }])).toMatchObject({ skipped: true });
  });

  it('checkDates skips short runs without dates and fails long ones', () => {
    const romance: Romance = {
      id: 'r',
      pair: ['a', 'b'],
      stage: 'crush',
      since: 0,
      crushFrom: ['a'],
      dates: [],
      updatedAt: 0,
    };
    expect(checkDates([romance], 1)).toMatchObject({ skipped: true });
    expect(checkDates([romance], 3)).toMatchObject({ pass: false });
    const dated = {
      ...romance,
      dates: [
        {
          eventId: 'e',
          locationId: 'ferris_wheel',
          at: 1020,
          askedBy: 'a',
          status: 'planned' as const,
          source: 'llm' as const,
        },
      ],
    };
    expect(checkDates([dated], 1)).toMatchObject({ pass: true });
  });

  it('formatReport prints SKIP and leaves skipped checks out of the tally', () => {
    const out = formatReport([
      { id: 'AC1', title: 't', pass: true, detail: 'd' },
      { id: 'AC15', title: 't', pass: true, skipped: true, detail: 'd' },
    ]);
    expect(out).toContain('SKIP  AC15');
    expect(out).toContain('1/1 checks passed (1 skipped)');
  });
});
