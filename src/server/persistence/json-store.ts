import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { MindSnapshot } from '../cognition/types.ts';
import type { Memory } from '../../shared/types.ts';
import { createLogger } from '../log.ts';
import { decodeEmbedding, encodeEmbedding } from './codec.ts';
import { migrate } from './migrations.ts';
import { SAVE_SCHEMA_VERSION, type SaveData, type SaveStore } from './types.ts';

const log = createLogger('persistence');

export const WORLD_FILE = 'world.json';
export const MEMORIES_DIR = 'memories';
export const REPLAY_FILE = 'replay.jsonl';

export class SaveFormatError extends Error {}

/** Memory as stored on disk: the embedding is a base64 Float32 string. */
type StoredMemory = Omit<Memory, 'embedding'> & { embeddingB64?: string };

interface MemoryFile {
  schemaVersion: number;
  villagerId: string;
  memories: StoredMemory[];
}

type StoredWorld = Omit<SaveData, 'minds'> & { minds: Omit<MindSnapshot, 'memories'>[] };

export interface JsonSaveStoreOptions {
  /** Root save directory (config persistence.dir). */
  dir: string;
  /** Slot name (config persistence.slot). */
  slot: string;
}

/**
 * JSON save slot: `<dir>/<slot>/world.json`, `<dir>/<slot>/memories/<villagerId>.json`, `<dir>/<slot>/replay.jsonl`.
 * Every file is written to a temp file and renamed. world.json is written last, so a crash mid-save
 * leaves the previous world.json pointing at memories that are at most one save newer.
 */
export class JsonSaveStore implements SaveStore {
  readonly slotDir: string;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(opts: JsonSaveStoreOptions) {
    if (!/^[\w-]+$/.test(opts.slot)) throw new Error(`Invalid save slot "${opts.slot}"`);
    this.slotDir = resolve(opts.dir, opts.slot);
  }

  get replayPath(): string {
    return join(this.slotDir, REPLAY_FILE);
  }

  async exists(): Promise<boolean> {
    return existsSync(join(this.slotDir, WORLD_FILE));
  }

  save(data: SaveData): Promise<void> {
    // Snapshot synchronously so later sim mutations cannot leak into a queued save.
    const world: StoredWorld = JSON.parse(
      JSON.stringify({
        ...data,
        schemaVersion: SAVE_SCHEMA_VERSION,
        minds: data.minds.map(({ memories: _memories, ...rest }) => rest),
      }),
    );
    const memoryFiles: MemoryFile[] = data.minds.map((m) => ({
      schemaVersion: SAVE_SCHEMA_VERSION,
      villagerId: m.villagerId,
      memories: m.memories.map(toStored),
    }));
    return this.serialize(() => this.write(world, memoryFiles));
  }

  load(): Promise<SaveData | null> {
    return this.serialize(() => this.read());
  }

  appendReplay(line: unknown): Promise<void> {
    const raw = `${JSON.stringify(line)}\n`;
    return this.serialize(async () => {
      await mkdir(this.slotDir, { recursive: true });
      await appendFile(this.replayPath, raw, 'utf8');
    });
  }

  /** Delete the whole slot (new game). */
  clear(): Promise<void> {
    return this.serialize(() => rm(this.slotDir, { recursive: true, force: true }));
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async write(world: StoredWorld, memoryFiles: MemoryFile[]): Promise<void> {
    const memDir = join(this.slotDir, MEMORIES_DIR);
    await mkdir(memDir, { recursive: true });
    const keep = new Set<string>();
    for (const file of memoryFiles) {
      const name = memoryFileName(file.villagerId);
      keep.add(name);
      await atomicWrite(join(memDir, name), JSON.stringify(file));
    }
    await atomicWrite(join(this.slotDir, WORLD_FILE), JSON.stringify(world));
    // A saved slot always has a replay log, even before anything was recorded.
    await appendFile(this.replayPath, '', 'utf8');
    // Memory files of villagers no longer in the save (e.g. strangers who left).
    for (const name of await readdir(memDir)) {
      if (name.endsWith('.json') && !keep.has(name)) await rm(join(memDir, name), { force: true });
    }
  }

  private async read(): Promise<SaveData | null> {
    const worldPath = join(this.slotDir, WORLD_FILE);
    if (!existsSync(worldPath)) return null;
    const world = migrate(await readJson(worldPath)) as StoredWorld;
    checkWorldShape(world, worldPath);
    const minds: MindSnapshot[] = [];
    for (const mind of world.minds) {
      const path = join(this.slotDir, MEMORIES_DIR, memoryFileName(mind.villagerId));
      let memories: Memory[] = [];
      if (existsSync(path)) {
        const file = (await readJson(path)) as MemoryFile;
        if (!Array.isArray(file.memories)) throw new SaveFormatError(`${path}: "memories" is not an array`);
        memories = file.memories.map(fromStored);
      } else {
        log.warn(`no memory file for ${mind.villagerId}; starting with empty memories`);
      }
      minds.push({ ...mind, memories });
    }
    return { ...world, minds };
  }
}

function toStored(m: Memory): StoredMemory {
  const { embedding, ...rest } = m;
  return embedding ? { ...rest, embeddingB64: encodeEmbedding(embedding) } : rest;
}

function fromStored(m: StoredMemory): Memory {
  const { embeddingB64, ...rest } = m;
  return embeddingB64 ? { ...rest, embedding: decodeEmbedding(embeddingB64) } : rest;
}

/** Villager ids become file names; anything outside [\w-] is percent-encoded. */
export function memoryFileName(villagerId: string): string {
  return `${villagerId.replace(/[^\w-]/g, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`)}.json`;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, path);
}

async function readJson(path: string): Promise<unknown> {
  const raw = await readFile(path, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new SaveFormatError(`${path} is not valid JSON: ${(err as Error).message}`);
  }
}

function checkWorldShape(w: StoredWorld, path: string): void {
  const arrays = [
    'villagers',
    'minds',
    'events',
    'notes',
    'conversations',
    'rumors',
    'items',
    'worldEvents',
    'strangers',
  ];
  if (typeof w.time !== 'number') throw new SaveFormatError(`${path}: "time" must be a number`);
  for (const key of arrays) {
    if (!Array.isArray((w as unknown as Record<string, unknown>)[key])) {
      throw new SaveFormatError(`${path}: "${key}" must be an array`);
    }
  }
  if (!w.player || typeof w.player !== 'object') throw new SaveFormatError(`${path}: "player" is missing`);
}
