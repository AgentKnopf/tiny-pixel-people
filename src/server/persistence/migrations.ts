import { SAVE_SCHEMA_VERSION } from './types.ts';

type Migration = (data: Record<string, unknown>) => Record<string, unknown>;

/**
 * MIGRATIONS[n] upgrades a save from schemaVersion n to n + 1.
 * When SaveData changes incompatibly, bump SAVE_SCHEMA_VERSION and add a migration here.
 */
export const MIGRATIONS: Record<number, Migration> = {};

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
