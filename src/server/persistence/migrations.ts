import { SAVE_SCHEMA_VERSION } from './types.ts';

type Migration = (data: Record<string, unknown>) => Record<string, unknown>;

/** v1 -> v2 (spec v2 §15): add the v2 fields with empty defaults; the engine seeds animals etc. on restore. */
function migrateV1toV2(data: Record<string, unknown>): Record<string, unknown> {
  const player =
    data.player && typeof data.player === 'object' ? (data.player as Record<string, unknown>) : null;
  return {
    animals: [],
    farm: { seeded: false, nextSeq: 1, lastLifecycleDay: null, lastButcherDay: null },
    train: null,
    visitors: [],
    hotel: null,
    romances: [],
    houseVisits: [],
    stock: {},
    letters: [],
    notices: [],
    keep: [],
    ...data,
    ...(player ? { player: { inside: null, ...player } } : {}),
  };
}

/**
 * MIGRATIONS[n] upgrades a save from schemaVersion n to n + 1.
 * When SaveData changes incompatibly, bump SAVE_SCHEMA_VERSION and add a migration here.
 */
export const MIGRATIONS: Record<number, Migration> = {
  1: migrateV1toV2,
};
export function migrate(input: unknown): unknown {
  if (!input || typeof input !== 'object') throw new Error('Save file is not a JSON object');
  let data = input as Record<string, unknown>;
  let version = data.schemaVersion;
  if (typeof version !== 'number') throw new Error('Save file has no schemaVersion');
  if (version > SAVE_SCHEMA_VERSION) {
    throw new Error(`Save file schemaVersion ${version} is newer than supported (${SAVE_SCHEMA_VERSION})`);
  }
  while (version < SAVE_SCHEMA_VERSION) {
    const step = MIGRATIONS[version];
    if (!step) throw new Error(`No migration from save schemaVersion ${version}`);
    data = { ...step(data), schemaVersion: version + 1 };
    version += 1;
  }
  return data;
}
