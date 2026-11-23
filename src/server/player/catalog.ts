import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { Catalogs } from './types.ts';

const itemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  emoji: z.string().min(1),
  sprite: z.string().min(1),
});

const decorationSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  emoji: z.string().min(1),
  cost: z.number().int().min(0),
  sprite: z.string().min(1),
  slot: z.number().int().min(0),
});

export const strangerTemplateSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/, 'stranger ids may only contain a-z, 0-9 and _'),
  name: z.string().min(1).max(24),
  age: z.number().int().min(1).max(120),
  occupation: z.string().min(1),
  bio: z.string().min(1),
  traits: z.array(z.string()),
  sprite: z.string().min(1),
  likes: z.array(z.string()).default([]),
  /** A piece of news the stranger carries into town (seed memory, gossip-able). */
  news: z.string().min(1),
});

export type StrangerTemplate = z.infer<typeof strangerTemplateSchema>;

export interface WorldCatalogs extends Catalogs {
  strangers: StrangerTemplate[];
}

function uniqueIds<T extends { id: string }>(file: string, list: T[]): T[] {
  const seen = new Set<string>();
  for (const x of list) {
    if (seen.has(x.id)) throw new Error(`${file}: duplicate id "${x.id}"`);
    seen.add(x.id);
  }
  return list;
}

function readJson<T>(path: string, schema: z.ZodType<T>): T {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Could not read ${path}: ${(err as Error).message}`, { cause: err });
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid ${path}:\n${issues}`);
  }
  return parsed.data;
}

/** Load and validate data/items.json, data/decorations.json and data/strangers.json. */
export function loadCatalogs(dataDir = 'data'): WorldCatalogs {
  const file = (name: string) => resolve(dataDir, name);
  return {
    items: uniqueIds('items.json', readJson(file('items.json'), z.array(itemSchema))),
    decorations: uniqueIds('decorations.json', readJson(file('decorations.json'), z.array(decorationSchema))),
    strangers: uniqueIds('strangers.json', readJson(file('strangers.json'), z.array(strangerTemplateSchema))),
  };
}
