import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MockChatProvider } from '../../src/server/llm/providers/mock.ts';
import { createSimEngine, type EngineOptions } from '../../src/server/sim/engine.ts';
import { createStubMind } from '../../src/server/sim/stub-mind.ts';
import {
  DEFAULT_AMBIENT_DATA,
  DEFAULT_ZOO_DATA,
  WorldDataError,
  loadAmbientData,
  loadRomanceSeeds,
  loadZooData,
} from '../../src/server/sim/world.ts';
import { FOREST_SPECIES, ZOO_SPECIES } from '../../src/shared/types.ts';
import { at } from '../../src/shared/time.ts';
import { testConfig } from '../helpers/sim.ts';

const dir = mkdtempSync(join(tmpdir(), 'tpp-data-'));
let n = 0;
function file(data: unknown): string {
  const p = join(dir, `f${++n}.json`);
  writeFileSync(p, typeof data === 'string' ? data : JSON.stringify(data));
  return p;
}

function engine(worldData: EngineOptions['worldData']) {
  return createSimEngine({
    config: testConfig(),
    providers: { chat: new MockChatProvider(), embeddings: null },
    createMind: createStubMind,
    startAt: at(0, '10:00'),
    worldData,
  });
}

describe('world data files (data/zoo.json, ambient.json, romance.json)', () => {
  it('the committed files load and match the defined defaults', () => {
    expect(loadZooData()).toEqual(DEFAULT_ZOO_DATA);
    expect(loadAmbientData()).toEqual(DEFAULT_AMBIENT_DATA);
    expect(Object.keys(loadZooData().names).sort()).toEqual([...ZOO_SPECIES].sort());
    expect(Object.keys(loadAmbientData().forest).sort()).toEqual([...FOREST_SPECIES].sort());
    expect(loadRomanceSeeds()).toEqual([
      { pair: ['franzi', 'laude'], stage: 'crush', crushFrom: ['laude', 'franzi'], shy: true },
    ]);
  });

  it('a missing file means the defaults; partial files merge over them', () => {
    expect(loadZooData(join(dir, 'nope.json'))).toEqual(DEFAULT_ZOO_DATA);
    expect(loadAmbientData(join(dir, 'nope.json'))).toEqual(DEFAULT_AMBIENT_DATA);
    expect(loadRomanceSeeds(join(dir, 'nope.json'))).toEqual([]);
    const zoo = loadZooData(file({ counts: { lion: 4 }, names: { lion: ['Aslan'] } }));
    expect(zoo.counts).toEqual({ penguin: 3, flamingo: 3, lion: 4 });
    expect(zoo.names.lion).toEqual(['Aslan']);
    expect(zoo.names.panda).toEqual(['Bao', 'Mei']);
    expect(zoo.defaultCount).toEqual([1, 2]);
    const amb = loadAmbientData(file({ crow: { name: 'Corvo' }, forest: { fox: 0 } }));
    expect(amb.crow.name).toBe('Corvo');
    expect(amb.forest).toEqual({ ...DEFAULT_AMBIENT_DATA.forest, fox: 0 });
  });

  it('rejects invalid files with a WorldDataError naming the problem', () => {
    const bad: [() => unknown, RegExp][] = [
      [() => loadZooData(file('{not json')), /not valid JSON/],
      [() => loadZooData(file({ counts: { dragon: 1 } })), /counts/],
      [() => loadZooData(file({ counts: { lion: -1 } })), /counts\.lion/],
      [() => loadZooData(file({ defaultCount: [3, 1] })), /defaultCount/],
      [() => loadZooData(file({ names: { lion: [] } })), /names\.lion/],
      [() => loadZooData(file({ population: 3 })), /population|Unrecognized/i],
      [() => loadAmbientData(file({ crow: { name: '' } })), /crow\.name/],
      [() => loadAmbientData(file({ forest: { deer: 2.5 } })), /forest\.deer/],
      [() => loadRomanceSeeds(file([{ pair: ['a', 'a'], stage: 'crush', crushFrom: [] }])), /pair/],
      [() => loadRomanceSeeds(file([{ pair: ['a', 'b'], stage: 'crush', crushFrom: ['c'] }])), /crushFrom/],
      [() => loadRomanceSeeds(file([{ pair: ['a', 'b'], stage: 'flirting', crushFrom: [] }])), /stage/],
    ];
    for (const [load, msg] of bad) {
      expect(load).toThrow(WorldDataError);
      expect(load).toThrow(msg);
    }
  });

  it('default engine: the zoo, forest and crow follow the data files', () => {
    const e = engine(undefined);
    const animals = e.snapshot().animals ?? [];
    expect(animals.find((a) => a.species === 'crow')?.name).toBe('Quill');
    for (const sp of FOREST_SPECIES)
      expect(animals.filter((a) => a.species === sp)).toHaveLength(DEFAULT_AMBIENT_DATA.forest[sp]);
    expect(animals.filter((a) => a.species === 'penguin')).toHaveLength(3);
    for (const sp of ZOO_SPECIES) {
      const names = DEFAULT_ZOO_DATA.names[sp]!;
      for (const a of animals.filter((x) => x.species === sp)) expect(names).toContain(a.name);
    }
    expect(e.snapshot().romances?.map((r) => r.id)).toEqual(['romance-franzi-laude']);
    e.stop();
  });

  it('custom values flow through the real engine', () => {
    const e = engine({
      zoo: { defaultCount: [2, 2], counts: { lion: 4, penguin: 1 }, names: { lion: ['Aslan', 'Simba'] } },
      ambient: { crow: { name: 'Corvo' }, forest: { ...DEFAULT_AMBIENT_DATA.forest, deer: 0, fox: 1 } },
      romances: [{ pair: ['mia', 'ben'], stage: 'dating', crushFrom: ['mia', 'ben'] }],
    });
    const animals = e.snapshot().animals ?? [];
    expect(animals.find((a) => a.species === 'crow')?.name).toBe('Corvo');
    expect(animals.filter((a) => a.species === 'deer')).toHaveLength(0);
    expect(animals.filter((a) => a.species === 'fox')).toHaveLength(1);
    const lions = animals.filter((a) => a.species === 'lion');
    expect(lions).toHaveLength(4);
    expect(lions.map((l) => l.name)).toEqual(expect.arrayContaining(['Aslan', 'Simba']));
    expect(animals.filter((a) => a.species === 'penguin')).toHaveLength(1);
    expect(animals.filter((a) => a.species === 'panda')).toHaveLength(2);
    expect(e.snapshot().romances).toEqual([
      expect.objectContaining({ id: 'romance-ben-mia', pair: ['ben', 'mia'], stage: 'dating' }),
    ]);
    e.stop();
  });
});
