/**
 * Shared helpers for the v2 acceptance suites (test/acceptance/v2, spec v2 §18). Each suite gates on
 * `readyV2(...)` and names what it waits for with `waitingForV2(...)`.
 */
import type { Feature } from './features.ts';
import { featurePath, repoPath, SIM_FEATURES } from './features.ts';
import type { AnimalSim } from '../../src/server/sim/types.ts';
import type { Location, LocationKind, Point, WorldMap, WorldSnapshot } from '../../src/shared/types.ts';
import type { TestWorld } from './world.ts';

/** Feature sets per area; a suite takes the union of what it needs. */
export const V2 = {
  sim: SIM_FEATURES,
  animals: [...SIM_FEATURES, 'animals', 'zooData', 'ambientData'],
  farm: [...SIM_FEATURES, 'animals', 'farmEconomy'],
  rides: [...SIM_FEATURES, 'rides'],
  visitors: [...SIM_FEATURES, 'train', 'visitors', 'hotel', 'visitorProfiles'],
  interiors: [...SIM_FEATURES, 'player', 'houseVisits'],
  romance: [...SIM_FEATURES, 'romance', 'romanceData'],
  post: [...SIM_FEATURES, 'player', 'postOffice'],
} as const satisfies Record<string, readonly Feature[]>;

export const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** Walk the player to a tile with player.move; true once standing there. */
export async function walkPlayerTo(w: TestWorld, to: Point, maxMinutes = 180): Promise<boolean> {
  w.command({ type: 'player.move', to });
  return w.until(
    (x) => dist(x.state().player.pos, to) < 0.6 && x.state().player.path.length === 0,
    maxMinutes,
  );
}

export function loc(map: WorldMap, id: string): Location {
  const l = map.locations.find((x) => x.id === id);
  if (!l) throw new Error(`map has no location ${id}`);
  return l;
}

export const ofKind = (map: WorldMap, kind: LocationKind) => map.locations.filter((l) => l.kind === kind);

export const visitorIds = (s: WorldSnapshot) => new Set((s.visitors ?? []).map((v) => v.villagerId));

/** Visitors in town, as WP8 defines it: leavers check out 30 min before the train and no longer count. */
export const visitorsInTown = (s: WorldSnapshot) => (s.visitors ?? []).filter((v) => v.status !== 'leaving');

/** Words a butcher toast must never contain (spec v2 §3.3: no graphic words). */
export const GRAPHIC_WORDS = [
  'kill',
  'killed',
  'slaughter',
  'blood',
  'bloody',
  'dead',
  'death',
  'die',
  'died',
  'corpse',
  'carcass',
  'knife',
  'cleaver',
  'butchered',
  'meat grinder',
  'gore',
];

export function graphicWords(text: string): string[] {
  const t = text.toLowerCase();
  return GRAPHIC_WORDS.filter((w) => new RegExp(`\\b${w}\\b`).test(t));
}

/**
 * The AnimalSim factory exported by src/server/sim/animals.ts. Spec v2 names the interface only, so
 * a missing `createAnimalSim` export fails with the module's real export list instead of a TypeError.
 */
export async function animalSimFactory<O>(): Promise<(opts: O) => AnimalSim> {
  const rel = featurePath('animals');
  const mod = (await import(/* @vite-ignore */ repoPath(rel))) as Record<string, unknown>;
  const make = mod.createAnimalSim;
  if (typeof make !== 'function')
    throw new Error(
      `${rel} does not export createAnimalSim(opts); its exports: ${Object.keys(mod).join(', ') || 'none'}`,
    );
  return make as (opts: O) => AnimalSim;
}
