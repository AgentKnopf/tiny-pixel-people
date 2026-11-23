/**
 * A tiny deterministic SimEngine used only to self-test the harness and the acceptance checks
 * while the real engine (WP2) is not on the branch. Villagers follow a fixed plan: one minute
 * walking, then standing at the block's location.
 */
import type { ClientMessage, InspectDataMsg, ServerMessage } from '../../src/shared/protocol.ts';
import type {
  DayPlan,
  DoorNote,
  Location,
  Memory,
  VillagerProfile,
  VillagerState,
} from '../../src/shared/types.ts';
import { dayOf, minuteOfDay } from '../../src/shared/time.ts';
import { createPlaceholderMap, createPlaceholderSnapshot } from '../../src/server/sim/placeholder.ts';
import type { CreateSimEngine, SimEngine } from '../../src/server/sim/types.ts';

export const createFakeEngine: CreateSimEngine = (opts) => {
  const map = createPlaceholderMap();
  const houses: Location[] = [0, 1, 2].map((i) => ({
    id: `house_${i}`,
    name: `House ${i}`,
    kind: 'house',
    area: { x: 2 + i * 6, y: 2, w: 4, h: 3 },
    entry: { x: 4 + i * 6, y: 6 },
    door: { x: 4 + i * 6, y: 5 },
  }));
  map.locations.push(...houses);
  const profiles: VillagerProfile[] = houses.map((h, i) => ({
    id: `v${i}`,
    name: `Villager ${i}`,
    age: 30,
    occupation: 'tester',
    bio: 'A test villager.',
    traits: [],
    homeId: h.id,
    sprite: '',
    wakeTime: '06:00',
    sleepTime: '22:00',
  }));
  let time = opts.startAt ?? 360;
  const listeners = new Set<(m: ServerMessage) => void>();
  const emit = (m: ServerMessage) => listeners.forEach((l) => l(m));
  const memories = new Map<string, Memory[]>(profiles.map((p) => [p.id, []]));
  const notes: DoorNote[] = [];
  let seq = 0;
  const remember = (
    villagerId: string,
    text: string,
    kind: Memory['kind'] = 'observation',
    importance = 2,
  ) => {
    const id = `m${seq++}`;
    memories.get(villagerId)!.push({
      id,
      villagerId,
      createdAt: time,
      lastAccessedAt: time,
      kind,
      text,
      importance,
      keywords: [],
      meta: { originId: id },
    });
  };
  const planFor = (p: VillagerProfile): DayPlan => ({
    day: dayOf(time),
    summary: 'test plan',
    revision: 0,
    source: 'llm',
    createdAt: time,
    blocks: [
      { start: 360, end: 540, locationId: p.homeId, activity: 'Breakfast', emoji: '🍳' },
      { start: 540, end: 1020, locationId: 'square', activity: 'Chatting', emoji: '💬' },
      { start: 1020, end: 1320, locationId: p.homeId, activity: 'Reading', emoji: '📖' },
    ],
  });
  const villagers: VillagerState[] = profiles.map((p) => {
    const home = houses.find((h) => h.id === p.homeId)!;
    return {
      id: p.id,
      pos: { ...home.entry },
      facing: 'down',
      path: [],
      locationId: p.homeId,
      status: 'idle',
      activity: { text: '', emoji: '', locationId: p.homeId, since: time },
      thought: '',
      needs: { hunger: 80, energy: 80, social: 80, fun: 80 },
      plan: planFor(p),
      relationships: {},
    };
  });
  const step = () => {
    time += 1;
    const mod = minuteOfDay(time);
    for (const v of villagers) {
      const p = profiles.find((x) => x.id === v.id)!;
      if (mod === 360) v.plan = planFor(p);
      const block = v.plan?.blocks.find((b) => b.start <= mod && mod < b.end);
      if (!block) {
        v.status = 'sleeping';
        continue;
      }
      const loc = map.locations.find((l) => l.id === block.locationId)!;
      if (v.locationId !== loc.id && v.status !== 'walking') {
        v.status = 'walking';
        v.locationId = null;
        v.path = [{ ...loc.entry }];
      } else if (v.status === 'walking') {
        v.pos = { ...loc.entry };
        v.path = [];
        v.locationId = loc.id;
        v.status = 'acting';
        remember(v.id, `I arrived at ${loc.name}`);
        for (const n of notes)
          if (n.houseId === loc.id && n.ownerId === v.id && n.status === 'unread') {
            n.status = 'read';
            n.readAt = time;
            remember(v.id, `I found a note: ${n.text}`, 'note', 8);
            n.reply = `Thanks for your note about '${n.text.split(' ').slice(0, 6).join(' ')}'`;
            n.repliedAt = time;
            n.status = 'replied';
            emit({ type: 'note.updated', note: { ...n } });
          }
      } else if (v.status !== 'acting') v.status = 'acting';
      v.activity = {
        text: block.activity,
        emoji: block.emoji ?? '',
        locationId: block.locationId,
        since: time,
      };
    }
    emit({ type: 'tick', time, speed: 1, villagers: [] });
  };
  const snapshot = () => ({
    ...createPlaceholderSnapshot(time, 1),
    villagers: structuredClone(villagers),
    notes: structuredClone(notes),
  });
  const engine: SimEngine = {
    map,
    profiles,
    now: () => time,
    snapshot,
    start: () => {},
    stop: () => {},
    setSpeed: () => {},
    async advance(minutes) {
      for (let i = 0; i < minutes; i++) step();
    },
    handleCommand(cmd: ClientMessage): ServerMessage[] {
      switch (cmd.type) {
        case 'inspect': {
          if (!cmd.villagerId) return [];
          const v = villagers.find((x) => x.id === cmd.villagerId)!;
          const msg: InspectDataMsg = {
            type: 'inspect.data',
            villagerId: v.id,
            state: structuredClone(v),
            plan: v.plan,
            memories: [...memories.get(v.id)!]
              .reverse()
              .slice(0, 10)
              .map(({ embedding: _e, ...m }) => m),
            relationships: v.relationships,
          };
          return [msg];
        }
        case 'note.post': {
          const owner = profiles.find((p) => p.homeId === cmd.houseId)!;
          const note: DoorNote = {
            id: `n${notes.length}`,
            houseId: cmd.houseId,
            ownerId: owner.id,
            authorId: 'player',
            text: cmd.text,
            postedAt: time,
            status: 'unread',
          };
          notes.push(note);
          emit({ type: 'note.updated', note: { ...note } });
          return [];
        }
        case 'debug.inject':
          remember(cmd.villagerId, cmd.text, 'heard', cmd.importance ?? 5);
          return [];
        default:
          return [{ type: 'error', message: `fake engine: ${cmd.type} not supported` }];
      }
    },
    onMessage(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    memories: (id) => memories.get(id) ?? [],
    conversations: () => [],
    toSaveData: () => {
      throw new Error('fake engine: no save');
    },
  };
  return engine;
};
