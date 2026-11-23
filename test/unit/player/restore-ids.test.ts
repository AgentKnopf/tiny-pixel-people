import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../../src/server/config.ts';
import { JsonSaveStore, SAVE_SCHEMA_VERSION, type SaveData } from '../../../src/server/persistence/index.ts';
import {
  createPlayerWorld,
  type PlayerWorld,
  type PlayerWorldSave,
} from '../../../src/server/player/index.ts';
import { at } from '../../../src/shared/time.ts';
import type { PlayerState } from '../../../src/shared/types.ts';
import { catalogs, FakeHost, profile, testConfig, villager } from './fake-host.ts';
import { addInteriors } from './v2-fixtures.ts';

const KEEP_MAX = 4;
const T = at(0, '09:00') + 0.25;

function world(restore?: Partial<PlayerWorldSave>, keepMax = KEEP_MAX): { host: FakeHost; pw: PlayerWorld } {
  const host = new FakeHost();
  addInteriors(host);
  host.add(
    profile('laude', 'Laude', 'house_ben', { occupation: 'Postmaster' }),
    villager('laude', { x: 24, y: 6 }),
  );
  host.time = T;
  const config = { ...testConfig(), post: { ...DEFAULT_CONFIG.post, keepMax } };
  const pw = createPlayerWorld({ host, config, catalogs, restore });
  (pw.state as PlayerState).pos = { x: 24, y: 5 };
  return { host, pw };
}

/** Letters, notices and a rumor in one game minute: more Keep entries than KEEP_MAX. */
function busyMinute(pw: PlayerWorld, tag: string): void {
  for (const to of ['ada', 'ben', 'cy'])
    expect(pw.handleCommand({ type: 'letter.send', to, text: `Letter ${tag} for ${to}` })).toEqual([]);
  expect(pw.handleCommand({ type: 'notice.post', text: `Notice ${tag}` })).toEqual([]);
  expect(pw.handleCommand({ type: 'player.rumor', villagerId: 'ada', text: `Rumor ${tag}` })).toEqual([]);
}

/** Every counter-made id in a WP8 save part, with where it was found. */
function ids(save: Partial<PlayerWorldSave>): Map<string, string> {
  const found = new Map<string, string>();
  const walk = (v: unknown, path: string): void => {
    if (typeof v === 'string') {
      if (/^[a-z][a-z_]*_\d+_\d+$/.test(v) && !found.has(v)) found.set(v, path);
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
  };
  walk(save, '');
  return found;
}

function toSaveData(part: PlayerWorldSave): SaveData {
  return {
    schemaVersion: SAVE_SCHEMA_VERSION,
    savedAt: new Date(0).toISOString(),
    time: T,
    rngState: 1,
    villagers: [],
    minds: [],
    events: [],
    notes: [],
    conversations: [],
    ...part,
  };
}

function wp8Part(d: SaveData): Partial<PlayerWorldSave> {
  return {
    player: d.player,
    rumors: d.rumors,
    weather: d.weather,
    items: d.items,
    worldEvents: d.worldEvents,
    strangers: d.strangers,
    stock: d.stock,
    hotel: d.hotel ?? null,
    visitors: d.visitors,
    houseVisits: d.houseVisits,
    letters: d.letters,
    notices: d.notices,
    keep: d.keep,
  };
}

describe('ids after a same-minute save, load and continue', () => {
  it('never reissues a saved id or overwrites saved letters, notices and Keep entries', async () => {
    const a = world();
    busyMinute(a.pw, 'before');
    const saved = a.pw.serialize();
    expect(saved.keep).toHaveLength(KEEP_MAX);
    expect(a.pw.post.keep.size()).toBe(KEEP_MAX);

    const store = new JsonSaveStore({ dir: mkdtempSync(join(tmpdir(), 'tpp-ids-')), slot: 'ids' });
    await store.save(toSaveData(saved));
    const loaded = await store.load();
    expect(loaded).not.toBeNull();

    const b = world(wp8Part(loaded!));
    expect(b.host.time).toBe(T);
    // Enough letters that a counter restarted at 0 reaches the saved letter ids.
    for (let i = 0; i < 6; i++)
      expect(b.pw.handleCommand({ type: 'letter.send', to: 'ben', text: `Extra after ${i}` })).toEqual([]);
    busyMinute(b.pw, 'after');
    const after = b.pw.serialize();

    const before = ids(saved);
    const fresh = [...ids(after).keys()].filter((id) => !before.has(id));
    expect(fresh.length).toBeGreaterThan(0);
    const newLetters = after.letters.filter((l) => l.text.includes('after'));
    const newNotices = after.notices.filter((n) => n.text.includes('after'));
    const newKeep = after.keep.filter((e) => e.text.includes('after'));
    for (const x of [...newLetters, ...newNotices, ...newKeep]) expect(before.has(x.id), x.id).toBe(false);
    for (const n of newNotices) expect(before.has(n.originId!), n.originId).toBe(false);
    for (const r of after.rumors.filter((r) => r.text.includes('after'))) {
      expect(before.has(r.id), r.id).toBe(false);
      expect(before.has(r.originMemoryId), r.originMemoryId).toBe(false);
    }

    // Saved records survive untouched next to the new ones.
    for (const l of saved.letters) expect(after.letters).toContainEqual(l);
    for (const n of saved.notices) expect(after.notices).toContainEqual(n);
    expect(after.letters).toHaveLength(saved.letters.length + 9);

    // The counters continue above every saved suffix (Keep has its own counter).
    const suffix = (id: string) => Number(id.split('_').at(-1));
    const top = (all: string[]) => Math.max(0, ...all.map(suffix));
    const savedCtx = [...before.keys()].filter((id) => !id.startsWith('keep_'));
    const savedKeep = saved.keep.map((e) => e.id);
    for (const id of fresh)
      expect(suffix(id), id).toBeGreaterThan(top(id.startsWith('keep_') ? savedKeep : savedCtx));
    expect(new Set(after.letters.map((l) => l.id)).size).toBe(after.letters.length);
    expect(new Set(after.keep.map((e) => e.id)).size).toBe(after.keep.length);
    expect(
      b.host
        .of('keep.added')
        .map((m) => m.entry.id)
        .filter((id) => before.has(id)),
    ).toEqual([]);
  });

  it.each([
    ['the same keepMax', KEEP_MAX],
    ['a smaller keepMax after loading', 1],
  ])('a trimmed Keep never reuses an id Laude still remembers (%s)', (_label, keepMax) => {
    const a = world();
    busyMinute(a.pw, 'one');
    busyMinute(a.pw, 'two');
    const saved = JSON.parse(JSON.stringify(a.pw.serialize())) as PlayerWorldSave;
    // Laude's memories outlive trimming and are saved outside the WP8 part.
    const remembered = a.host
      .memoriesOf('laude')
      .map((m) => m.meta?.keepId)
      .filter((id): id is string => typeof id === 'string');
    const kept = new Set(saved.keep.map((e) => e.id));
    expect(remembered.filter((id) => !kept.has(id)).length).toBeGreaterThan(0);

    const b = world(saved, keepMax);
    expect(b.pw.post.keep.size()).toBe(Math.min(keepMax, saved.keep.length));
    busyMinute(b.pw, 'three');
    const added = b.host.of('keep.added').map((m) => m.entry.id);
    expect(added.length).toBeGreaterThan(0);
    for (const id of added) expect(remembered, id).not.toContain(id);
    const laudeNow = b.host.memoriesOf('laude').map((m) => m.meta?.keepId);
    for (const id of laudeNow) expect(remembered, String(id)).not.toContain(id);
  });

  it('starts above suffixes seen anywhere in an older save', () => {
    const a = world();
    a.pw.handleCommand({ type: 'player.rumor', villagerId: 'ada', text: 'Old rumor' });
    const saved = JSON.parse(JSON.stringify(a.pw.serialize())) as PlayerWorldSave;
    saved.rumors[0]!.originMemoryId = `fact_${Math.floor(T)}_40`;
    const b = world(saved);
    b.pw.handleCommand({ type: 'player.rumor', villagerId: 'ben', text: 'New rumor' });
    const rumor = b.pw.serialize().rumors.find((r) => r.text.includes('New'))!;
    expect(Number(rumor.id.split('_').at(-1))).toBeGreaterThan(40);
  });
});
