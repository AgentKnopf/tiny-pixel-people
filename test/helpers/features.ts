/**
 * Feature detection for the acceptance suite. Suites that depend on code from another work package
 * are skipped until the files the spec assigns to that package exist on the branch, so the suite can
 * land early and turns itself on as packages merge. Set TPP_ACCEPTANCE_STRICT=1 to run everything
 * regardless (an unimplemented feature then fails instead of skipping).
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const FEATURE_FILES = {
  engine: 'src/server/sim/engine.ts',
  mind: 'src/server/cognition/mind.ts',
  queue: 'src/server/llm/queue.ts',
  needs: 'src/server/sim/needs.ts',
  player: 'src/server/player/player.ts',
  rumors: 'src/server/player/rumors.ts',
  worldEvents: 'src/server/player/world-events.ts',
  economy: 'src/server/player/economy.ts',
  inventory: 'src/server/player/inventory.ts',
  pet: 'src/server/player/pet.ts',
  decor: 'src/server/player/decor.ts',
  persistence: 'src/server/persistence/json-store.ts',
  villageMap: ['data/map/village.json', 'assets/maps/village.json'],
  villagers: 'data/villagers.json',
  items: 'data/items.json',
  decorations: 'data/decorations.json',
  strangers: 'data/strangers.json',
  // v2 (technical-spec-v2.md §19). WP8 file names beyond post-office.ts are not fixed by the spec,
  // so the likely names are listed; add the real one here when the package lands.
  animals: 'src/server/sim/animals.ts',
  rides: 'src/server/sim/rides.ts',
  train: 'src/server/sim/train.ts',
  romance: 'src/server/cognition/romance.ts',
  postOffice: 'src/server/player/post-office.ts',
  hotel: ['src/server/player/hotel.ts', 'src/server/player/hotel-service.ts'],
  visitors: ['src/server/player/visitors.ts', 'src/server/player/visitor-service.ts'],
  houseVisits: [
    'src/server/player/house-visits.ts',
    'src/server/player/house-visit.ts',
    'src/server/player/interiors.ts',
  ],
  farmEconomy: ['src/server/player/farm-economy.ts', 'src/server/player/farm.ts'],
  zooData: 'data/zoo.json',
  ambientData: 'data/ambient.json',
  romanceData: 'data/romance.json',
  visitorProfiles: 'data/visitors.json',
  saveV1Fixture: 'test/fixtures/save-v1.json',
} as const satisfies Record<string, string | readonly string[]>;

export type Feature = keyof typeof FEATURE_FILES;

export const STRICT = /^(1|true|yes)$/i.test(process.env.TPP_ACCEPTANCE_STRICT ?? '');

export function repoPath(rel: string): string {
  return fileURLToPath(new URL(rel, new URL('../../', import.meta.url)));
}

function candidates(feature: Feature): readonly string[] {
  const f: string | readonly string[] = FEATURE_FILES[feature];
  return typeof f === 'string' ? [f] : f;
}

/** Repo-relative path of the first existing file for a feature (or its first candidate). */
export function featurePath(feature: Feature): string {
  const c = candidates(feature);
  return c.find((p) => existsSync(repoPath(p))) ?? c[0]!;
}

export function has(feature: Feature): boolean {
  return candidates(feature).some((p) => existsSync(repoPath(p)));
}

/** True when every listed feature exists (or strict mode is on). */
export function ready(...features: Feature[]): boolean {
  return STRICT || features.every(has);
}

/** Suffix for describe() titles so skipped suites say what they wait for. */
export function waitingFor(...features: Feature[]): string {
  const missing = features.filter((f) => !has(f));
  return missing.length && !STRICT
    ? ` [skipped: waiting for ${missing.map((f) => candidates(f).join(' or ')).join(', ')}]`
    : '';
}

/** The headless simulation needs the engine, a real mind and the LLM queue. */
export const SIM_FEATURES: Feature[] = ['engine', 'mind', 'queue'];

/** v2 needs the 128×60 map (spec v2 §2); the v1 map file exists at the same path until art lands. */
export function mapIsV2(): boolean {
  if (STRICT) return true;
  try {
    const map = JSON.parse(readFileSync(repoPath(featurePath('villageMap')), 'utf8')) as { width?: number };
    return map.width === 128;
  } catch {
    return false;
  }
}

/** Like waitingFor(), also naming the v2 map when it is still the v1 one. */
export function waitingForV2(...features: Feature[]): string {
  const parts: string[] = [];
  const missing = features.filter((f) => !has(f));
  if (!STRICT) {
    if (!mapIsV2()) parts.push('the 128x60 map');
    parts.push(...missing.map((f) => candidates(f).join(' or ')));
  }
  return parts.length ? ` [skipped: waiting for ${parts.join(', ')}]` : '';
}

/** True when the v2 map and every listed feature exist (or strict mode is on). */
export function readyV2(...features: Feature[]): boolean {
  return STRICT || (mapIsV2() && features.every(has));
}
