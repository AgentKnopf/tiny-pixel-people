import { formatClock } from '../../shared/time.ts';
import {
  PLAYER_ID,
  type DayPlan,
  type DoorNote,
  type DoorNoteStatus,
  type HouseVisit,
  type Letter,
  type LetterStatus,
  type Romance,
  type RomanceStage,
  type VillagerId,
  type VisitorInfo,
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

  // ---------- v2 (spec v2 §17) ----------

  const romanceSeen = new Map<
    string,
    { stage: RomanceStage; crush: Set<VillagerId>; dates: Map<string, string> }
  >();
  const remember = (r: Romance) =>
    romanceSeen.set(r.id, {
      stage: r.stage,
      crush: new Set(r.crushFrom),
      dates: new Map(r.dates.map((d) => [d.eventId, d.status])),
    });
  for (const r of engine.romances()) remember(r);
  const datesLogged = new Set<string>();
  const logDate = (eventId: string, pair: string[], place: string | null | undefined) => {
    if (datesLogged.has(eventId)) return;
    datesLogged.add(eventId);
    log.add('date', pair, `${nameOf(pair[0]!)} and ${nameOf(pair[1]!)} went on a date at ${placeOf(place)}`, {
      eventId,
      ...(place ? { location: place } : {}),
    });
  };

  offs.push(
    bus.on('romance.updated', ({ romance: r }) => {
      const prev = romanceSeen.get(r.id);
      remember(r);
      const [a, b] = r.pair;
      const pair = `${nameOf(a)} and ${nameOf(b)}`;
      const data = { romanceId: r.id, stage: r.stage };
      let logged = false;
      for (const who of r.crushFrom) {
        if (prev?.crush.has(who)) continue;
        const other = who === a ? b : a;
        log.add('crush', [who, other], `${nameOf(who)} has a crush on ${nameOf(other)}`, {
          ...data,
          ...(r.shy ? { shy: true } : {}),
        });
        logged = true;
      }
      for (const d of r.dates) {
        const was = prev?.dates.get(d.eventId);
        if (was === d.status) continue;
        const other = d.askedBy === a ? b : a;
        const where = placeOf(d.locationId);
        if (d.status === 'planned' && was === undefined) {
          log.add(
            'date_asked',
            [d.askedBy, other],
            `${nameOf(d.askedBy)} asked ${nameOf(other)} on a date at ${where} (${formatClock(d.at)})`,
            { ...data, eventId: d.eventId, location: d.locationId },
          );
          logged = true;
        } else if (d.status === 'done') {
          logDate(d.eventId, [a, b], d.locationId);
          logged = true;
        } else if (d.status === 'missed') {
          log.add('date_missed', [a, b], `${pair} missed their date at ${where}`, {
            ...data,
            eventId: d.eventId,
          });
          logged = true;
        }
      }
      if (prev && prev.stage !== r.stage) {
        if (r.stage === 'couple') log.add('couple', [a, b], `${pair} are a couple now`, data);
        else if (r.stage === 'ended') log.add('romance_ended', [a, b], `${pair} broke up`, data);
        else log.add('romance', [a, b], `${pair}: ${prev.stage} → ${r.stage}`, data);
      } else if (!prev && r.stage !== 'crush') {
        log.add('romance', [a, b], `${pair}: ${r.stage}`, data);
      } else if (!logged && prev) {
        log.add('romance', [a, b], `${pair}: romance updated (${r.stage})`, data);
      }
    }),
  );

  offs.push(
    bus.on('event.done', ({ event: e }) => {
      if (e.kind !== 'date') return;
      logDate(e.id, [e.hostId, ...e.attendees.filter((x) => x !== e.hostId)], e.locationId);
    }),
  );

  offs.push(
    bus.on('train', (e) => {
      if (e.kind === 'arrived') {
        const arriving = engine.train?.state(e.at).arriving ?? [];
        const n = arriving.length;
        log.add(
          'train_arrived',
          [...arriving],
          `The train arrived at the station${n ? ` with ${n} visitor(s)` : ''}`,
          {
            arrivesAt: e.arrivesAt,
            passengers: n,
          },
        );
      } else if (e.kind === 'departing') {
        const leaving = engine.train?.state(e.at).departing ?? [];
        log.add(
          'train_departed',
          [...leaving],
          `The train left the station${leaving.length ? ` with ${leaving.map(nameOf).join(', ')}` : ''}`,
          { arrivesAt: e.arrivesAt, passengers: leaving.length },
        );
      }
    }),
  );

  offs.push(
    bus.on('ride', (e) => {
      if (e.kind !== 'boarded') return;
      log.add(
        'ride',
        [e.riderId],
        `${nameOf(e.riderId)} rode the ${placeOf(e.rideId).replace(/^the /i, '')}`,
        {
          ride: e.rideId,
        },
      );
    }),
  );

  offs.push(
    bus.on('food.eaten', (e) => {
      log.add(
        'purchase',
        [e.villagerId],
        `${nameOf(e.villagerId)} bought ${e.itemId.replace(/_/g, ' ')} at ${placeOf(e.venueId)}`,
        { venue: e.venueId, item: e.itemId },
      );
    }),
  );

  const farmer = (): VillagerId[] => {
    const id = engine.villagerIds().find((v) => /farmer/i.test(engine.profile(v)?.occupation ?? ''));
    return id ? [id] : [];
  };

  offs.push(
    bus.on('animals.step', ({ change }) => {
      for (const a of change.added) {
        if (a.group !== 'farm') continue;
        const who = a.name ? `${a.name} the ${a.species}` : `A ${a.species}`;
        log.add('animal_born', farmer(), `${who} was born at ${placeOf(a.homeId)}`, {
          animalId: a.id,
          species: a.species,
        });
      }
      for (const a of change.removed) {
        const butchered = a.reason === 'butcher';
        log.add(
          butchered ? 'animal_butchered' : 'animal_died',
          farmer(),
          butchered ? `A ${a.species} was butchered` : `A ${a.species} died of old age`,
          { animalId: a.id, species: a.species },
        );
      }
    }),
  );

  const letterStatus = new Map<string, LetterStatus>();
  const noticeSeen = new Set<string>();
  const visitorStatus = new Map<VillagerId, VisitorInfo['status']>();
  const visitsSeen = new Set<string>();
  const pw = engine.playerWorld.snapshot();
  for (const l of pw.letters) letterStatus.set(l.id, l.status);
  for (const n of pw.notices) noticeSeen.add(n.id);
  for (const v of pw.visitors) visitorStatus.set(v.villagerId, v.status);
  for (const v of pw.houseVisits) visitsSeen.add(v.id);

  const onLetter = (l: Letter) => {
    const prev = letterStatus.get(l.id);
    letterStatus.set(l.id, l.status);
    if (prev === l.status) return;
    const data = { letterId: l.id, ...(l.replyTo ? { replyTo: l.replyTo } : {}) };
    const order: LetterStatus[] = ['posted', 'delivered', 'read', 'replied'];
    const from = prev ? order.indexOf(prev) + 1 : 0;
    const to = order.indexOf(l.status);
    const what = l.replyTo ? 'reply' : 'letter';
    for (let i = from; i <= to; i++) {
      const s = order[i]!;
      if (s === 'posted')
        log.add(
          'letter_sent',
          [l.from, l.to],
          `${nameOf(l.from)} posted a ${what} to ${nameOf(l.to)}: "${clip(l.text, 120)}"`,
          data,
        );
      else if (s === 'delivered')
        log.add(
          'letter_delivered',
          [l.to, l.from],
          `The crow delivered ${nameOf(l.from)}'s ${what} to ${nameOf(l.to)}`,
          data,
        );
      else if (s === 'read')
        log.add(
          'letter_read',
          [l.to, l.from],
          `${nameOf(l.to)} read the ${what} from ${nameOf(l.from)}`,
          data,
        );
      else
        log.add(
          'letter_replied',
          [l.to, l.from],
          `${nameOf(l.to)} replied to ${nameOf(l.from)}'s ${what}`,
          data,
        );
    }
    if (l.status === 'returned')
      log.add('letter_delivered', [l.from], `${nameOf(l.from)}'s ${what} came back undelivered`, {
        ...data,
        returned: true,
      });
  };

  const onVisitor = (v: VisitorInfo) => {
    const prev = visitorStatus.get(v.villagerId);
    visitorStatus.set(v.villagerId, v.status);
    if (prev === v.status) return;
    if (v.status === 'checkedIn')
      log.add(
        'visitor_checked_in',
        [v.villagerId],
        `${nameOf(v.villagerId)} checked in at the hotel${v.roomId ? ` (room ${v.roomId})` : ''}`,
        {
          room: v.roomId,
          departsAt: v.departsAt,
        },
      );
  };

  const onVisit = (v: HouseVisit) => {
    if (visitsSeen.has(v.id)) return;
    visitsSeen.add(v.id);
    const owners = v.ownerIds.map(nameOf).join(' and ');
    const house = placeOf(v.houseId);
    log.add(
      v.kind === 'snoop' ? 'snooping' : 'house_visit',
      [PLAYER_ID, ...v.ownerIds],
      v.kind === 'snoop'
        ? `${nameOf(PLAYER_ID)} snooped around ${house} while ${owners} was out`
        : v.kind === 'sleeping'
          ? `${nameOf(PLAYER_ID)} tiptoed into ${house} while ${owners} slept`
          : `${nameOf(PLAYER_ID)} visited ${owners} at ${house}`,
      { visitId: v.id, house: v.houseId, kind: v.kind },
    );
  };
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
        case 'letter.updated':
          onLetter(msg.letter);
          return;
        case 'notice.updated':
          if (msg.removed || noticeSeen.has(msg.notice.id)) return;
          noticeSeen.add(msg.notice.id);
          log.add(
            'notice_posted',
            [msg.notice.authorId],
            `${nameOf(msg.notice.authorId)} pinned a notice: "${clip(msg.notice.text, 120)}"`,
            { noticeId: msg.notice.id, expiresAt: msg.notice.expiresAt },
          );
          return;
        case 'keep.added': {
          const e = msg.entry;
          log.add(
            'keep_logged',
            [e.authorId, ...(e.recipientId ? [e.recipientId] : [])],
            `Laude filed a ${e.kind} in the Keep: "${clip(e.text, 100)}"`,
            { keepId: e.id, kind: e.kind, refId: e.refId },
          );
          return;
        }
        case 'visitor.updated':
          onVisitor(msg.visitor);
          return;
        case 'visit.updated':
          onVisit(msg.visit);
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
