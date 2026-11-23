import { formatClock } from '../../shared/time.ts';
import {
  PLAYER_ID,
  type DayPlan,
  type DoorNote,
  type DoorNoteStatus,
  type VillagerId,
} from '../../shared/types.ts';
import { Mind } from '../cognition/mind.ts';
import type { Engine } from './engine.ts';
import type { TownLog } from './town-log.ts';
import { locationById } from './world.ts';

const clip = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function planSignature(p: DayPlan): string[] {
  return p.blocks.map((b) => `${b.start}|${b.locationId}|${b.activity}`);
}

/**
 * Turns engine activity into town log entries. Listens only (bus events, broadcasts, a cheap scan
 * of new memories per game minute); it never changes sim state or starts LLM work.
 */
export function recordTownLog(engine: Engine, log: TownLog): () => void {
  const names = new Map<VillagerId, string>();
  const nameOf = (id: VillagerId): string => {
    if (id === PLAYER_ID) return engine.playerWorld.state.name;
    const n = engine.profile(id)?.name;
    if (n) names.set(id, n);
    return n ?? names.get(id) ?? id;
  };
  const placeOf = (id: string | null | undefined): string =>
    id ? (locationById(engine.map.locations, id)?.name ?? id) : 'somewhere';

  const lastPlace = new Map<VillagerId, string>();
  const plans = new Map<VillagerId, { day: number; sig: string[] }>();
  const noteStatus = new Map<string, DoorNoteStatus>();
  const worldEvents = new Set<string>();
  const seenReflections = new Set<string>();
  let lastScan = engine.now();

  for (const id of engine.villagerIds()) {
    nameOf(id);
    const s = engine.villager(id);
    if (s?.locationId) lastPlace.set(id, s.locationId);
    if (s?.plan) plans.set(id, { day: s.plan.day, sig: planSignature(s.plan) });
  }
  for (const n of engine.notes()) noteStatus.set(n.id, n.status);
  for (const e of engine.playerWorld.snapshot().worldEvents) worldEvents.add(e.id);

  const offs: (() => void)[] = [];
  const bus = engine.bus;

  offs.push(
    bus.on('villager.arrived', ({ villagerId, locationId }) => {
      if (lastPlace.get(villagerId) === locationId) return;
      lastPlace.set(villagerId, locationId);
      log.add('move', [villagerId], `${nameOf(villagerId)} arrived at ${placeOf(locationId)}`, {
        location: locationId,
      });
    }),
  );

  offs.push(
    bus.on('conversation.ended', ({ conversation: c }) => {
      if (c.messages.length === 0) return;
      const [a, b] = c.participants;
      const first = c.messages[0]!;
      log.add(
        'chat',
        [a, b],
        `${nameOf(a)} and ${nameOf(b)} talked at ${placeOf(c.locationId)} (${c.messages.length} lines): ` +
          `${nameOf(first.speakerId)}: "${clip(first.text, 100)}"`,
        { conversationId: c.id, location: c.locationId, lines: c.messages.length, status: c.status },
      );
    }),
  );

  offs.push(
    bus.on('plan.changed', ({ villagerId, plan }) => {
      if (!plan) return;
      const sig = planSignature(plan);
      const prev = plans.get(villagerId);
      plans.set(villagerId, { day: plan.day, sig });
      const name = nameOf(villagerId);
      const data = { day: plan.day + 1, revision: plan.revision, source: plan.source };
      if (!prev || prev.day !== plan.day) {
        const first = plan.blocks[0];
        const start = first
          ? ` First: ${formatClock(first.start)} ${first.activity} at ${placeOf(first.locationId)}.`
          : '';
        log.add(
          'plan_change',
          [villagerId],
          `${name} planned day ${plan.day + 1}: ${clip(plan.summary, 120)}${start}`,
          data,
        );
        return;
      }
      const old = new Set(prev.sig);
      const added = plan.blocks.filter((b, i) => !old.has(sig[i]!));
      if (added.length === 0 && sig.length === prev.sig.length) return;
      const b = added[0];
      log.add(
        'plan_change',
        [villagerId],
        b
          ? `${name} changed plans: ${formatClock(b.start)} ${b.activity} at ${placeOf(b.locationId)}`
          : `${name} dropped something from today's plan`,
        data,
      );
    }),
  );

  offs.push(
    bus.on('learned', ({ fact }) => {
      if (fact.from === fact.to) return;
      log.add(
        'gossip_spread',
        [fact.from, fact.to],
        `${nameOf(fact.from)} told ${nameOf(fact.to)}: ${clip(fact.text)}`,
        {
          originId: fact.originId,
          ...(fact.conversationId ? { conversationId: fact.conversationId } : {}),
        },
      );
    }),
  );

  offs.push(
    bus.on('event.started', ({ event: e }) => {
      log.add(
        'event_start',
        [e.hostId, ...e.attendees.filter((a) => a !== e.hostId)],
        `${nameOf(e.hostId)}'s "${e.title}" started at ${placeOf(e.locationId)}`,
        { eventId: e.id, location: e.locationId, accepted: e.accepted.length },
      );
    }),
  );

  offs.push(
    bus.on('step', ({ time }) => {
      if (Math.floor(time) <= Math.floor(lastScan)) return;
      const from = lastScan - 1;
      lastScan = time;
      for (const id of engine.villagerIds()) {
        const mind = engine.mind(id);
        if (!(mind instanceof Mind)) continue;
        const all = mind.memory.all();
        for (let i = all.length - 1; i >= 0; i--) {
          const m = all[i]!;
          if (m.createdAt < from) break;
          if (m.kind !== 'reflection' || seenReflections.has(m.id)) continue;
          seenReflections.add(m.id);
          log.add('reflection', [id], `${nameOf(id)} reflected: ${clip(m.text)}`, { memoryId: m.id });
        }
      }
      if (seenReflections.size > 1000) seenReflections.clear();
    }),
  );

  const onNote = (n: DoorNote) => {
    const prev = noteStatus.get(n.id);
    noteStatus.set(n.id, n.status);
    if (prev === undefined) {
      log.add(
        'note_left',
        [n.authorId, n.ownerId],
        `${nameOf(n.authorId)} left a note for ${nameOf(n.ownerId)}: "${clip(n.text, 120)}"`,
        {
          noteId: n.id,
          house: n.houseId,
        },
      );
    }
    if ((prev === undefined || prev === 'unread') && n.status !== 'unread') {
      const reply = n.reply ? ` and replied: "${clip(n.reply, 120)}"` : '';
      log.add(
        'note_read',
        [n.ownerId, n.authorId],
        `${nameOf(n.ownerId)} read the note from ${nameOf(n.authorId)}${reply}`,
        {
          noteId: n.id,
          house: n.houseId,
        },
      );
    }
  };

  offs.push(
    engine.onMessage((msg) => {
      switch (msg.type) {
        case 'note.updated':
          onNote(msg.note);
          return;
        case 'villagers.changed':
          for (const p of msg.added) {
            names.set(p.id, p.name);
            if (p.transient)
              log.add('visitor_arrived', [p.id], `${p.name} (${p.occupation}) arrived in town`, {
                visitor: true,
              });
          }
          for (const id of msg.removed) {
            log.add('visitor_left', [id], `${nameOf(id)} left town`);
            lastPlace.delete(id);
            plans.delete(id);
          }
          return;
        case 'world.event': {
          const e = msg.event;
          if (worldEvents.has(e.id) || e.kind === 'townEvent' || e.kind === 'stranger') return;
          worldEvents.add(e.id);
          const who = typeof e.data.villagerId === 'string' ? e.data.villagerId : null;
          const text =
            e.kind === 'rain'
              ? 'It started to rain'
              : e.kind === 'party'
                ? 'A party started'
                : e.kind === 'birthday' && who
                  ? `It's ${nameOf(who)}'s birthday`
                  : `World event: ${e.kind}`;
          log.add('event_start', who ? [who] : [], text, { worldEventId: e.id, kind: e.kind });
          return;
        }
      }
    }),
  );

  return () => offs.forEach((off) => off());
}
