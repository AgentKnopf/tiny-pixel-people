import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_CONFIG, loadConfig, type PartialConfig } from '../../src/server/config.ts';
import { TASK_PRIORITY } from '../../src/server/llm/types.ts';
import { mockAnswer } from '../../src/server/llm/providers/mock.ts';
import { migrate } from '../../src/server/persistence/migrations.ts';
import { SAVE_SCHEMA_VERSION } from '../../src/server/persistence/types.ts';
import { FARM_CAP_PER_SPECIES, FOREST_SPECIES, ZOO_SPECIES } from '../../src/shared/types.ts';
import { PROTOCOL_VERSION } from '../../src/shared/protocol.ts';

const load = (overrides?: PartialConfig) =>
  loadConfig({ env: {}, cwd: '/nonexistent-dir-for-tests', overrides });

describe('v2 contracts', () => {
  it('bumps the save schema and protocol versions to 2', () => {
    expect(SAVE_SCHEMA_VERSION).toBe(2);
    expect(PROTOCOL_VERSION).toBe(2);
  });

  it('migrates a v1 save to v2 with empty v2 defaults and keeps v1 data', () => {
    const v1 = {
      schemaVersion: 1,
      savedAt: '2026-01-01T00:00:00.000Z',
      time: 600,
      rngState: 7,
      villagers: [{ id: 'mia', pos: { x: 4, y: 6 } }],
      minds: [],
      events: [],
      notes: [{ id: 'n1', text: 'hi' }],
      conversations: [],
      player: { id: 'player', name: 'You', gold: 42, pos: { x: 4, y: 27 } },
      rumors: [],
      weather: { state: 'clear', since: 0, until: null },
      items: [],
      worldEvents: [],
      strangers: [],
      observer: { log: [], anchors: [] },
    };
    const out = migrate(structuredClone(v1)) as Record<string, unknown>;
    expect(out.schemaVersion).toBe(2);
    expect(out.farm).toEqual({ seeded: false, nextSeq: 1, lastLifecycleDay: null, lastButcherDay: null });
    for (const k of ['animals', 'visitors', 'romances', 'houseVisits', 'letters', 'notices', 'keep'])
      expect(out[k]).toEqual([]);
    expect(out.hotel).toBeNull();
    expect(out.train).toBeNull();
    expect(out.stock).toEqual({});
    expect(out.player).toEqual({ ...v1.player, inside: null });
    expect(out.villagers).toEqual(v1.villagers);
    expect(out.notes).toEqual(v1.notes);
    expect(out.observer).toEqual(v1.observer);
  });

  it('does not overwrite v2 fields that are already present', () => {
    const out = migrate({
      schemaVersion: 1,
      letters: [{ id: 'l1' }],
      player: { inside: { locationId: 'hotel' } },
    }) as Record<string, unknown>;
    expect(out.letters).toEqual([{ id: 'l1' }]);
    expect(out.player).toEqual({ inside: { locationId: 'hotel' } });
  });

  it('has v2 config defaults and keeps the farm hard cap', () => {
    const cfg = load(undefined);
    expect(cfg.farm.capPerSpecies).toBe(FARM_CAP_PER_SPECIES);
    expect(cfg.visitors).toMatchObject({ min: 2, max: 4, stayDays: [1, 3] });
    expect(cfg.hotel.rooms).toBe(6);
    expect(cfg.post.deliveryTimes).toEqual(['11:00', '17:00']);
    expect(cfg.train.arrivals).toEqual(['10:00', '16:00']);
    expect(DEFAULT_CONFIG.world.llmVisitors).toBe(true);
    expect(() => load({ farm: { capPerSpecies: 11 } })).toThrow(ConfigError);
  });

  it('rejects visitor settings the hotel cannot hold', () => {
    expect(() => load({ visitors: { max: 8 } })).toThrow(/visitors\.max/);
    expect(() => load({ visitors: { min: 5, max: 4 } })).toThrow(/visitors\.min/);
    expect(() => load({ visitors: { stayDays: [3, 1] } })).toThrow(/stayDays/);
  });

  it('lists 12 zoo and 7 forest species', () => {
    expect(ZOO_SPECIES).toHaveLength(12);
    expect(FOREST_SPECIES).toHaveLength(7);
  });

  it('gives the new LLM tasks priorities and deterministic mock answers', () => {
    expect(TASK_PRIORITY['visit.greet']).toBe(105);
    expect(TASK_PRIORITY['letter.write']).toBe(45);
    const ask = (task: Parameters<typeof mockAnswer>[0]['task'], meta: Record<string, unknown>) =>
      JSON.parse(mockAnswer({ task, messages: [], meta })) as Record<string, unknown>;
    expect(ask('visit.greet', { playerName: 'Robin' }).reply).toContain('Robin');
    expect(ask('letter.reply', { letterText: 'The mayor cat is named Biscuit' }).reply).toContain('Biscuit');
    expect(ask('date.ask', { venues: [{ id: 'ferris_wheel', name: 'Ferris wheel' }] })).toMatchObject({
      locationId: 'ferris_wheel',
      start: '17:00',
    });
    expect(ask('date.decide', { affinity: 5 }).accept).toBe(true);
    expect(ask('date.decide', { affinity: 1 }).accept).toBe(false);
    const visitor = ask('visitor.create', { existingNames: ['Marlo'] });
    expect(visitor.name).not.toBe('Marlo');
    expect(visitor.occupation).not.toBe('Traveller');
    expect(typeof ask('letter.write', { toName: 'Laude' }).text).toBe('string');
  });
});
