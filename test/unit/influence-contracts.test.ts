/** Influence API shared contracts (specs/influence-api-v2.md §4-§8). Types and constants only. */
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { JsonSaveStore } from '../../src/server/persistence/json-store.ts';
import {
  SAVE_SCHEMA_VERSION,
  type InfluenceSaveData,
  type SaveData,
} from '../../src/server/persistence/types.ts';
import { createPlaceholderSnapshot } from '../../src/server/sim/placeholder.ts';
import { TOWN_EVENT_TYPES } from '../../src/server/sim/town-log.ts';
import type { SimEngine } from '../../src/server/sim/types.ts';
import {
  INFLUENCE_ENDPOINTS,
  INFLUENCE_ERRORS,
  INFLUENCE_TEXT_MAX,
  RUMOUR_SOURCE_LABELS,
  RUMOUR_SOURCES,
  type InfluenceEntry,
  type InfluenceRequest,
  type InfluenceResult,
} from '../../src/shared/influence.ts';
import { NOTE_MAX_LENGTH, NOTICE_MAX_LENGTH, SAY_MAX_LENGTH } from '../../src/shared/protocol.ts';
import { PLAYER_ID, type DoorNote, type MemoryMeta } from '../../src/shared/types.ts';

const tmpDir = () => mkdtempSync(join(tmpdir(), 'tpp-influence-'));

const influence: InfluenceSaveData = {
  day: 3,
  used: 5,
  nextId: 6,
  entries: [
    {
      id: 'inf_1',
      tick: 3 * 1440 + 480,
      ts: '2025-01-01T08:00:00.000Z',
      day: 3,
      time: '08:00',
      endpoint: 'rumour',
      payload: { to: 'laude', text: 'The post office is open late.', source: 'crow' },
      targets: ['laude'],
      refs: { originId: 'fact_9' },
      outcomes: { spreadTo: [{ from: 'laude', to: 'franzi', tick: 3 * 1440 + 530 }] },
    },
    {
      id: 'inf_2',
      tick: 3 * 1440 + 490,
      ts: '2025-01-01T08:10:00.000Z',
      day: 3,
      time: '08:10',
      endpoint: 'note',
      payload: { to: 'franzi', text: 'Look under the bench.', signed: 'the crow' },
      targets: ['franzi'],
      refs: { noteId: 'note_4' },
      outcomes: { readAt: 3 * 1440 + 1100, repliedAt: 3 * 1440 + 1120, replySource: 'fallback' },
    },
    {
      id: 'inf_3',
      tick: 3 * 1440 + 500,
      ts: '2025-01-01T08:20:00.000Z',
      day: 3,
      time: '08:20',
      endpoint: 'event',
      payload: {
        title: 'Lantern walk',
        text: 'Bring a lantern.',
        location: 'lake',
        time: '20:00',
        minutes: 90,
      },
      targets: ['mia', 'tom'],
      refs: { eventId: 'ev_2', worldEventId: 'we_7' },
      outcomes: { accepted: ['mia'], declined: ['tom'], attended: [], status: 'scheduled' },
    },
    {
      id: 'inf_4',
      tick: 3 * 1440 + 510,
      ts: '2025-01-01T08:30:00.000Z',
      day: 3,
      time: '08:30',
      endpoint: 'nudge',
      payload: { agent: 'olga', thought: 'I keep thinking about the pink house.' },
      targets: ['olga'],
      refs: {},
      outcomes: { planAfter: { tick: 3 * 1440 + 1300, revision: 0, source: 'llm' } },
      visitor: true,
    },
    {
      id: 'inf_5',
      tick: 3 * 1440 + 520,
      ts: '2025-01-01T08:40:00.000Z',
      day: 3,
      time: '08:40',
      endpoint: 'weather',
      payload: { weather: 'rain', hours: 2 },
      targets: [],
      refs: { worldEventId: 'we_8' },
      outcomes: { startedAt: 3 * 1440 + 520, endedAt: 3 * 1440 + 640, swaps: 4 },
    },
  ],
};

function sampleSave(): SaveData {
  const snap = createPlaceholderSnapshot(3 * 1440 + 600, 1);
  const note: DoorNote = {
    id: 'note_4',
    houseId: 'house_franzi',
    ownerId: 'franzi',
    authorId: PLAYER_ID,
    text: 'Look under the bench.',
    postedAt: 3 * 1440 + 490,
    status: 'unread',
    signature: 'the crow',
    anonymous: true,
  };
  return {
    schemaVersion: SAVE_SCHEMA_VERSION,
    savedAt: new Date(0).toISOString(),
    time: 3 * 1440 + 600,
    rngState: 1,
    villagers: [],
    minds: [
      {
        villagerId: 'olga',
        memories: [
          {
            id: 'm1',
            villagerId: 'olga',
            createdAt: 3 * 1440 + 510,
            lastAccessedAt: 3 * 1440 + 510,
            kind: 'observation',
            text: 'I keep thinking about the pink house.',
            importance: 3,
            keywords: [],
            meta: { influenceId: 'inf_4' },
          },
        ],
        bookkeeping: { importanceSinceReflection: 3, lastReflectionAt: null, lastPlanAt: null },
      },
    ],
    events: [],
    notes: [note],
    conversations: [],
    player: snap.player,
    rumors: [],
    weather: { state: 'clear', since: 0, until: null },
    items: [],
    worldEvents: [],
    strangers: [],
    influence,
  };
}

describe('influence contracts', () => {
  it('has the approved rumour sources and labels', () => {
    expect([...RUMOUR_SOURCES]).toEqual(['passerby', 'traveller', 'crow', 'child']);
    expect(RUMOUR_SOURCE_LABELS).toEqual({
      passerby: 'A passerby',
      traveller: 'A traveller from the train',
      crow: 'The crow',
      child: 'A child in the square',
    });
  });

  it('has the spec text caps, endpoints and error ids', () => {
    expect(INFLUENCE_TEXT_MAX).toEqual({
      rumour: 300,
      nudge: 300,
      note: 500,
      eventText: 200,
      eventTitle: 40,
      signature: 24,
    });
    expect(INFLUENCE_TEXT_MAX.rumour).toBe(SAY_MAX_LENGTH);
    expect(INFLUENCE_TEXT_MAX.note).toBe(NOTE_MAX_LENGTH);
    expect(INFLUENCE_TEXT_MAX.eventText).toBe(NOTICE_MAX_LENGTH);
    expect([...INFLUENCE_ENDPOINTS]).toEqual(['rumour', 'note', 'event', 'nudge', 'weather']);
    expect([...INFLUENCE_ERRORS]).toEqual([
      'asleep',
      'already_raining',
      'not_raining',
      'board_full',
      'event_pending',
      'busy',
      'limit',
    ]);
  });

  it('adds the influence town log type', () => {
    expect(TOWN_EVENT_TYPES).toContain('influence');
  });

  it('keeps the save schema at version 2', () => {
    expect(SAVE_SCHEMA_VERSION).toBe(2);
  });

  it('round-trips the influence log, the note signature and the memory tag through a save', async () => {
    const store = new JsonSaveStore({ dir: tmpDir(), slot: 'influence' });
    const data = sampleSave();
    await store.save(data);
    const loaded = (await store.load())!;
    expect(loaded.influence).toEqual(influence);
    expect(loaded.notes[0]).toEqual(data.notes[0]);
    expect(loaded.minds[0]!.memories[0]!.meta).toEqual({ influenceId: 'inf_4' });
  });

  it('loads the v1 fixture without an influence field', async () => {
    const dir = tmpDir();
    cpSync(join(import.meta.dirname, '../fixtures/save-v1'), join(dir, 'save-v1'), { recursive: true });
    const loaded = (await new JsonSaveStore({ dir, slot: 'save-v1' }).load())!;
    expect(loaded.schemaVersion).toBe(SAVE_SCHEMA_VERSION);
    expect(loaded.influence).toBeUndefined();
    expect(loaded.notes.every((n) => n.signature === undefined && n.anonymous === undefined)).toBe(true);
  });

  it('types: entries and requests narrow by endpoint; the engine methods are optional', () => {
    const e = influence.entries[0]!;
    if (e.endpoint === 'rumour')
      expectTypeOf(e.payload.source).toEqualTypeOf<'passerby' | 'traveller' | 'crow' | 'child'>();
    expectTypeOf<
      Extract<InfluenceEntry, { endpoint: 'weather' }>['outcomes']['swaps']
    >().toEqualTypeOf<number>();
    expectTypeOf<Extract<InfluenceRequest, { endpoint: 'nudge' }>['body']>().toHaveProperty('thought');
    expectTypeOf<Extract<InfluenceResult, { error: 'limit' }>['status']>().toEqualTypeOf<429>();
    expectTypeOf<Extract<InfluenceResult, { error: 'asleep' }>>().toHaveProperty('wakesAt');
    expectTypeOf<MemoryMeta['influenceId']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<SimEngine['applyInfluence']>().toEqualTypeOf<
      ((req: InfluenceRequest, opts?: { ts?: string }) => InfluenceResult) | undefined
    >();
  });
});
