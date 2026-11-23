/** AC20: letters between villagers and the player (spec v2 §8.1). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServerMessage } from '../../../src/shared/protocol.ts';
import {
  PLAYER_ID,
  type GameMinutes,
  type Letter,
  type LetterStatus,
  type VillagerId,
} from '../../../src/shared/types.ts';
import { at, dayOf } from '../../../src/shared/time.ts';
import { readyV2, waitingForV2, type Feature } from '../../helpers/features.ts';
import { dist, loc, V2, walkPlayerTo } from '../../helpers/v2.ts';
import { awake, createTestWorld, keywords, type TestWorld } from '../../helpers/world.ts';

const F: Feature[] = [...V2.post];

const LETTER = 'The old lighthouse lantern glows purple at midnight now. Have you seen the purple lantern?';
const FAR_LETTER = 'This letter was written far away from the post office.';

const isError = (replies: readonly ServerMessage[]) => replies.some((m) => m.type === 'error');

/** The first delivery round strictly after `t`. */
function nextRound(times: readonly string[], t: GameMinutes): GameMinutes {
  const day = dayOf(t);
  const rounds = [day, day + 1]
    .flatMap((d) => times.map((h) => at(d, h)))
    .filter((x) => x > t)
    .sort((a, b) => a - b);
  return rounds[0]!;
}

/** Latest version of every letter: the snapshot plus every letter.updated broadcast. */
function allLetters(w: TestWorld): Letter[] {
  const byId = new Map<string, Letter>();
  for (const m of w.of('letter.updated')) byId.set(m.letter.id, m.letter);
  for (const l of w.state().letters ?? []) byId.set(l.id, l);
  return [...byId.values()];
}

describe.skipIf(!readyV2(...F))(`AC20: letters${waitingForV2(...F)}`, () => {
  describe('the player writes to a villager', () => {
    let w: TestWorld;
    let farReplies: ServerMessage[] = [];
    let farDist = 0;
    let sendReplies: ServerMessage[] = [];
    let sentAt: GameMinutes = 0;
    let recipient: VillagerId = '';
    let letterId = '';
    let statusAtSend: LetterStatus | undefined;
    const statusesBeforeRound = new Set<LetterStatus>();
    let homeAtRead: boolean | null = null;
    let replyId = '';
    let replyStatusBeforeRead: LetterStatus | undefined;
    let readReplies: ServerMessage[] = [];

    const letter = () => allLetters(w).find((l) => l.id === letterId);
    const reply = () => allLetters(w).find((l) => l.id === replyId);

    beforeAll(async () => {
      w = await createTestWorld({ villagers: 12, startAt: '06:00', seed: 21 });
      const post = loc(w.engine.map, 'post_office');
      const door = post.door ?? post.entry;
      if (dist(w.state().player.pos, door) <= 3) await walkPlayerTo(w, loc(w.engine.map, 'square').entry);
      farDist = dist(w.state().player.pos, door);
      const someone = w.state().villagers[0]!.id;
      farReplies = w.command({ type: 'letter.send', to: someone, text: FAR_LETTER });

      if (!(await walkPlayerTo(w, post.entry))) throw new Error('the player could not reach the post office');
      if (w.now() > at(0, '09:00')) throw new Error('the walk to the post office took past 09:00');
      await w.advanceTo('09:00');

      const a = w
        .state()
        .villagers.find((v) => awake(v) && v.id !== 'laude' && v.locationId !== w.profile(v.id).homeId);
      if (!a) throw new Error('nobody is away from home at 09:00');
      recipient = a.id;
      const homeId = w.profile(recipient).homeId;
      sentAt = w.now();
      sendReplies = w.command({ type: 'letter.send', to: recipient, text: LETTER });
      const sent = allLetters(w).find((l) => l.from === PLAYER_ID && l.to === recipient && l.text === LETTER);
      if (!sent) throw new Error('letter.send created no letter');
      letterId = sent.id;
      statusAtSend = sent.status;

      const round = nextRound(w.config.post.deliveryTimes, sentAt);
      await w.until(
        (x) => {
          const l = letter();
          if (!l) return false;
          if (x.now() < round) statusesBeforeRound.add(l.status);
          if (homeAtRead === null && (l.status === 'read' || l.status === 'replied'))
            homeAtRead = x.villager(recipient).locationId === homeId;
          return homeAtRead !== null;
        },
        at(1, '14:00') - w.now(),
      );

      await w.until(() => {
        const r = allLetters(w).find(
          (l) => l.from === recipient && l.to === PLAYER_ID && l.replyTo === letterId,
        );
        if (r) replyId = r.id;
        return r?.status === 'delivered';
      }, 24 * 60);
      replyStatusBeforeRead = reply()?.status;
      if (replyId) readReplies = w.command({ type: 'letter.read', letterId: replyId });
      await w.advance(1);
    }, 600_000);

    afterAll(() => w?.dispose());

    it('is posted at once at the post office and delivered at the next round', () => {
      expect(isError(sendReplies)).toBe(false);
      const l = letter()!;
      expect(l).toBeDefined();
      expect(statusAtSend).toBe('posted');
      expect(l.postedAt).toBe(sentAt);
      expect(w.of('letter.updated').some((m) => m.letter.id === letterId)).toBe(true);
      const round = nextRound(w.config.post.deliveryTimes, sentAt);
      expect(round).toBe(at(0, '11:00'));
      expect([...statusesBeforeRound]).toEqual(['posted']);
      expect(l.deliveredAt).toBeDefined();
      expect(l.deliveredAt!).toBeGreaterThanOrEqual(round);
      expect(l.deliveredAt!).toBeLessThan(round + 2);
    });

    it('is read by the recipient on the next arrival home, with a letterId memory', () => {
      const l = letter()!;
      expect(['read', 'replied']).toContain(l.status);
      expect(l.readAt).toBeDefined();
      expect(l.readAt!).toBeGreaterThanOrEqual(l.deliveredAt!);
      expect(homeAtRead).toBe(true);
      const m = w.memories(recipient).find((x) => x.meta.letterId === letterId);
      expect(m, 'memory with meta.letterId').toBeDefined();
      expect(m!.kind).toBe('note');
      expect(m!.importance).toBe(6);
    });

    it('gets a letter.reply answer that quotes the letter, delivered to the player at the next round', () => {
      const call = w.provider.calls.find(
        (c) =>
          c.task === 'letter.reply' && typeof c.meta?.letterText === 'string' && c.meta.letterText === LETTER,
      );
      expect(call, 'letter.reply call with meta.letterText').toBeDefined();
      const r = reply();
      expect(r, 'reply letter').toBeDefined();
      expect(r!.to).toBe(PLAYER_ID);
      expect(r!.from).toBe(recipient);
      expect(letter()!.status).toBe('replied');
      const shared = keywords(r!.text).filter((k) => keywords(LETTER).includes(k));
      expect(shared.length, r!.text).toBeGreaterThanOrEqual(1);
      expect(r!.postedAt - letter()!.readAt!).toBeLessThanOrEqual(10);
      const round = nextRound(w.config.post.deliveryTimes, r!.postedAt);
      expect(r!.deliveredAt).toBeDefined();
      expect(r!.deliveredAt!).toBeGreaterThanOrEqual(round);
      expect(r!.deliveredAt!).toBeLessThan(round + 2);
      expect(replyStatusBeforeRead).toBe('delivered');
    });

    it('letter.read marks the reply read', () => {
      expect(isError(readReplies)).toBe(false);
      const r = reply()!;
      expect(r.status).toBe('read');
      expect(r.readAt).toBeDefined();
    });

    it('rejects letter.send away from the post office', () => {
      expect(farDist).toBeGreaterThan(2);
      expect(isError(farReplies)).toBe(true);
      expect(allLetters(w).some((l) => l.text === FAR_LETTER)).toBe(false);
    });
  });

  describe('villager-written letters over 3 days', () => {
    let w: TestWorld;
    let giver: VillagerId = '';
    let giftDay = -1;
    let gifted = false;

    beforeAll(async () => {
      w = await createTestWorld({ villagers: 12, startAt: '06:00', seed: 5 });
      await w.advanceTo('08:00');
      const item = w.state().items[0];
      if (!item) throw new Error('no ground item to pick up for a gift');
      if (!(await walkPlayerTo(w, item.pos, 180))) throw new Error('the player could not reach the item');
      await w.advance(1);
      const count = () => w.state().player.inventory.find((i) => i.itemId === item.itemId)?.count ?? 0;
      const before = count();
      const v = w.state().villagers.find((x) => awake(x) && x.id !== 'laude' && x.id !== 'franzi');
      if (!v) throw new Error('nobody is awake to receive a gift');
      giver = v.id;
      w.command({ type: 'player.gift', villagerId: giver, itemId: item.itemId });
      await w.until(
        (x) => x.of('conversation.message').some((m) => m.speakerId === giver && m.listenerId === PLAYER_ID),
        60,
      );
      gifted = count() < before;
      giftDay = dayOf(w.now());
      await w.advanceTo(at(3, '06:00'));
    }, 600_000);

    afterAll(() => w?.dispose());

    const villagerLetters = () => allLetters(w).filter((l) => l.from !== PLAYER_ID && !l.replyTo);

    it('respects post.maxVillagerLettersPerDay and at most 1 letter to the player per day', () => {
      const max = w.config.post.maxVillagerLettersPerDay;
      const perDay = new Map<number, Letter[]>();
      for (const l of villagerLetters())
        perDay.set(dayOf(l.postedAt), [...(perDay.get(dayOf(l.postedAt)) ?? []), l]);
      for (const [day, list] of perDay) {
        expect(list.length, `day ${day}`).toBeLessThanOrEqual(max);
        expect(list.filter((l) => l.to === PLAYER_ID).length, `day ${day} to the player`).toBeLessThanOrEqual(
          1,
        );
      }
    });

    it('a gift that day produces a thank-you letter to the player', () => {
      expect(gifted).toBe(true);
      const thanks = villagerLetters().find(
        (l) => l.from === giver && l.to === PLAYER_ID && dayOf(l.postedAt) === giftDay,
      );
      expect(thanks, 'thank-you letter').toBeDefined();
      expect(thanks!.text).toMatch(/thank/i);
      expect(
        w.provider.calls.some(
          (c) => c.task === 'letter.write' && c.meta?.reason === 'thanks' && c.meta.villagerId === giver,
        ),
      ).toBe(true);
    });
  });
});
