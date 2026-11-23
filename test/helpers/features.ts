/**
 * Feature detection for the acceptance suite. Suites that depend on code from another work package
 * are skipped until the files the spec assigns to that package exist on the branch, so the suite can
 * land early and turns itself on as packages merge. Set TPP_ACCEPTANCE_STRICT=1 to run everything
 * regardless (an unimplemented feature then fails instead of skipping).
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  // v2 (technical-spec-v2.md §19)
  animals: 'src/server/sim/animals.ts',
  rides: 'src/server/sim/rides.ts',
  train: 'src/server/sim/train.ts',
  romance: 'src/server/cognition/romance.ts',
  postOffice: 'src/server/player/post-office.ts',
  hotel: 'src/server/player/hotel.ts',
  visitors: 'src/server/player/visitors.ts',
  houseVisits: 'src/server/player/house-visits.ts',
  farmEconomy: 'src/server/player/farm-economy.ts',
  zooData: 'data/zoo.json',
  ambientData: 'data/ambient.json',
  romanceData: 'data/romance.json',
  visitorProfiles: 'data/visitors.json',
  saveV1Fixture: 'test/fixtures/save-v1/world.json',
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

/**
 * What the real engine actually wires up, probed once per test file by building an engine and
 * reading its snapshot: a service file existing on main is not enough, the v2 suites drive the
 * engine's entry points (snapshot fields, commands, broadcasts).
 */
type EngineCap =
  | 'animals'
  | 'rides'
  | 'train'
  | 'visitors'
  | 'hotel'
  | 'romances'
  | 'houseVisits'
  | 'letters'
  | 'stock'
  | 'newResidents';

const FEATURE_CAPS: Partial<Record<Feature, EngineCap[]>> = {
  animals: ['animals'],
  rides: ['rides'],
  train: ['train'],
  visitors: ['visitors', 'train'],
  hotel: ['hotel'],
  romance: ['romances'],
  houseVisits: ['houseVisits'],
  postOffice: ['letters'],
  farmEconomy: ['stock'],
  villagers: ['newResidents'],
};

const CAP_LABEL: Record<EngineCap, string> = {
  animals: 'snapshot.animals',
  rides: 'snapshot.rides',
  train: 'snapshot.train',
  visitors: 'snapshot.visitors',
  hotel: 'snapshot.hotel',
  romances: 'snapshot.romances',
  houseVisits: 'snapshot.houseVisits',
  letters: 'snapshot.letters',
  stock: 'snapshot.stock',
  newResidents: 'laude and franzi in the default roster',
};

async function probeEngine(): Promise<ReadonlySet<EngineCap>> {
  const caps = new Set<EngineCap>();
  if (STRICT || !mapIsV2() || !has('engine') || !has('mind') || !has('queue')) return caps;
  try {
    type Snap = Record<string, unknown> & { villagers: { id: string }[] };
    type Probe = { snapshot(): Snap; stop(): void };
    const { createSimEngine } = (await import(/* @vite-ignore */ repoPath(featurePath('engine')))) as {
      createSimEngine: (o: unknown) => Probe;
    };
    const { loadConfig } = (await import(/* @vite-ignore */ repoPath('src/server/config.ts'))) as {
      loadConfig: (o: unknown) => Record<string, unknown>;
    };
    const { MockChatProvider } = (await import(
      /* @vite-ignore */ repoPath('src/server/llm/providers/mock.ts')
    )) as { MockChatProvider: new () => unknown };
    const dir = mkdtempSync(join(tmpdir(), 'tpp-probe-'));
    const config = loadConfig({
      env: {},
      cwd: dir,
      overrides: {
        llm: { provider: 'mock', model: 'mock' },
        embeddings: { provider: 'none' },
        persistence: { dir: join(dir, 'saves'), loadOnStart: false, autosaveGameMinutes: 0 },
      },
    });
    const engine = createSimEngine({ config, providers: { chat: new MockChatProvider(), embeddings: null } });
    const s = engine.snapshot();
    engine.stop();
    for (const cap of Object.keys(CAP_LABEL) as EngineCap[])
      if (cap !== 'newResidents' && s[cap] !== undefined) caps.add(cap);
    const ids = new Set(s.villagers.map((v) => v.id));
    if (ids.has('laude') && ids.has('franzi')) caps.add('newResidents');
  } catch {
    // An engine that cannot be built leaves every v2 suite skipped; the v1 suites report the error.
  }
  return caps;
}

const ENGINE_CAPS = await probeEngine();

const missingCaps = (features: readonly Feature[]): EngineCap[] =>
  STRICT
    ? []
    : [...new Set(features.flatMap((f) => FEATURE_CAPS[f] ?? []))].filter((c) => !ENGINE_CAPS.has(c));

/** Like waitingFor(), also naming the v2 map and engine wiring that are still missing. */
export function waitingForV2(...features: Feature[]): string {
  const parts: string[] = [];
  if (!STRICT) {
    if (!mapIsV2()) parts.push('the 128x60 map');
    parts.push(...features.filter((f) => !has(f)).map((f) => candidates(f).join(' or ')));
    if (mapIsV2()) parts.push(...missingCaps(features.filter(has)).map((c) => `engine: ${CAP_LABEL[c]}`));
  }
  return parts.length ? ` [skipped: waiting for ${parts.join(', ')}]` : '';
}

/** True when the v2 map, every listed feature file and its engine wiring exist (or strict mode is on). */
export function readyV2(...features: Feature[]): boolean {
  return STRICT || (mapIsV2() && features.every(has) && missingCaps(features).length === 0);
}
