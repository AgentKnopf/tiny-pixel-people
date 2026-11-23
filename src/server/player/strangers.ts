import { z } from 'zod';
import { at, dayOf } from '../../shared/time.ts';
import type { Point, VillagerId, VillagerProfile, WorldEvent } from '../../shared/types.ts';
import type { StrangerTemplate } from './catalog.ts';
import type { Ctx } from './context.ts';
import { isWalkable } from './geometry.ts';
import type { CommandResult } from './types.ts';
import type { WorldEventLog } from './world-event-log.ts';

export const DEFAULT_MAX_VILLAGERS = 20;
/** Strangers leave at this time on the day they arrive. */
export const STRANGER_LEAVES_AT = '22:00';
/** Late arrivals (less than an hour before STRANGER_LEAVES_AT, or after it) leave at this time the next morning. */
export const LATE_STRANGER_LEAVES_AT = '02:00';

const llmStrangerSchema = z.object({
  name: z.string().min(1).max(24),
  age: z.number().int().min(1).max(120),
  occupation: z.string().min(1).max(60),
  bio: z.string().min(1).max(400),
  traits: z.array(z.string()).max(6).default([]),
  news: z.string().min(1).max(300),
});

/** First balanced JSON object in a model reply (tolerates code fences and chatter). */
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Transient visitors (spec §7.13 Stranger): walk in from the map edge, carry news, leave at day end. */
export class Strangers {
  profiles: VillagerProfile[] = [];
  private pending = false;

  constructor(
    private readonly ctx: Ctx,
    private readonly log: WorldEventLog,
    restored?: VillagerProfile[],
  ) {
    if (restored) this.profiles = structuredClone(restored);
    log.onClose('stranger', (ev) => this.depart(ev));
  }

  private get cap(): number {
    return this.ctx.cfg.maxVillagers ?? DEFAULT_MAX_VILLAGERS;
  }

  trigger(): CommandResult {
    if (this.pending) return { ok: false, reason: 'A stranger is already on the way' };
    if (this.ctx.host.villagers().length >= this.cap) {
      return { ok: false, reason: `The village is full (${this.cap} villagers)` };
    }
    const template = this.pickTemplate();
    if (!template) return { ok: false, reason: 'Every traveller is already in town' };
    const queue = this.ctx.host.llm;
    if (this.ctx.cfg.world.llmStrangers && queue) {
      this.pending = true;
      this.ctx.toast('🕵', 'A stranger is on the way…');
      queue
        .enqueue(
          {
            task: 'stranger.create',
            json: true,
            messages: strangerPrompt(this.ctx.host.villagers().map((v) => this.ctx.nameOf(v.id))),
            meta: { template },
          },
          { dedupeKey: 'stranger.create' },
        )
        .then((res) => this.fromLlm(res.text, template))
        .catch(() => template)
        .then((t) => {
          this.pending = false;
          // The world may have filled up while the model was thinking.
          if (this.ctx.host.villagers().length < this.cap) this.spawn(t);
        });
      return { ok: true };
    }
    this.spawn(template);
    return { ok: true };
  }

  private pickTemplate(): StrangerTemplate | null {
    const present = new Set(this.profiles.map((p) => p.id));
    const free = this.ctx.catalogs.strangers.filter((t) => !present.has(strangerId(t.id)));
    if (free.length === 0) return null;
    return free[Math.floor(this.ctx.host.random() * free.length)] ?? free[0]!;
  }

  private fromLlm(text: string, template: StrangerTemplate): StrangerTemplate {
    const parsed = llmStrangerSchema.safeParse(extractJsonObject(text));
    if (!parsed.success) return template;
    const taken = new Set(this.ctx.host.villagers().map((v) => this.ctx.nameOf(v.id).toLowerCase()));
    if (taken.has(parsed.data.name.toLowerCase())) return template;
    return { ...template, ...parsed.data };
  }

  spawn(t: StrangerTemplate): VillagerProfile {
    const now = this.ctx.host.now();
    const profile: VillagerProfile = {
      id: strangerId(t.id),
      name: t.name,
      age: t.age,
      occupation: t.occupation,
      bio: t.bio,
      traits: t.traits,
      homeId: this.publicLocationId(),
      sprite: t.sprite,
      wakeTime: '06:00',
      sleepTime: STRANGER_LEAVES_AT,
      seedMemories: [
        `I am ${t.name}, a ${t.occupation}, visiting this village for the day.`,
        `News I carry from the road: ${t.news}`,
      ],
      likes: t.likes,
      transient: true,
    };
    const departsAt = departureTime(now);
    this.profiles.push(profile);
    this.ctx.host.spawnVillager(profile, this.entryPoint());
    this.log.open('stranger', departsAt, { strangerId: profile.id, name: t.name });
    this.ctx.toast('🕵', `A stranger, ${t.name} the ${t.occupation}, arrived in the village`);
    this.ctx.log(`${t.name} (${t.occupation}) arrived in the village`);
    for (const v of this.ctx.awake()) {
      if (v.id === profile.id) continue;
      this.ctx.host.addMemory(v.id, {
        at: now,
        kind: 'event',
        text: `A stranger named ${t.name}, a ${t.occupation}, arrived in the village`,
        importance: 4,
      });
    }
    return profile;
  }

  private depart(ev: WorldEvent): void {
    const id = ev.data.strangerId as VillagerId | undefined;
    const profile = this.profiles.find((p) => p.id === id);
    if (!profile) return;
    this.profiles = this.profiles.filter((p) => p !== profile);
    this.ctx.host.removeVillager(profile.id);
    this.ctx.toast('👋', `${profile.name} left the village`);
    this.ctx.log(`${profile.name} left the village`);
  }

  private publicLocationId(): string {
    const locs = this.ctx.host.map.locations;
    return (
      locs.find((l) => l.id === 'square')?.id ??
      locs.find((l) => l.kind === 'public')?.id ??
      locs[0]?.id ??
      'square'
    );
  }

  /** A walkable tile on the outermost walkable ring of the map, nearest the vertical middle. */
  entryPoint(): Point {
    const map = this.ctx.host.map;
    const maxDepth = Math.floor(Math.min(map.width, map.height) / 2);
    for (let depth = 0; depth < maxDepth; depth++) {
      const ring: Point[] = [];
      for (let y = depth; y < map.height - depth; y++) {
        ring.push({ x: depth, y }, { x: map.width - 1 - depth, y });
      }
      for (let x = depth + 1; x < map.width - 1 - depth; x++) {
        ring.push({ x, y: depth }, { x, y: map.height - 1 - depth });
      }
      const ok = ring.filter((p) => isWalkable(map, p));
      if (ok.length === 0) continue;
      const midY = map.height / 2;
      const sides = ok.filter((p) => p.x === depth || p.x === map.width - 1 - depth);
      const pool = (sides.length > 0 ? sides : ok).sort(
        (a, b) => Math.abs(a.y - midY) - Math.abs(b.y - midY),
      );
      const best = pool.slice(0, 4);
      return best[Math.floor(this.ctx.host.random() * best.length)] ?? best[0]!;
    }
    return { x: 0, y: 0 };
  }
}

/** End of the arrival day, or 02:00 the next morning for late arrivals. */
export function departureTime(now: number): number {
  const day = dayOf(now);
  // Just after midnight counts as the same night.
  const early = at(day, LATE_STRANGER_LEAVES_AT);
  if (now < early) return Math.max(early, now + 30);
  const evening = at(day, STRANGER_LEAVES_AT);
  if (now < evening - 60) return evening;
  return at(day + 1, LATE_STRANGER_LEAVES_AT);
}

export function strangerId(templateId: string): VillagerId {
  return `stranger_${templateId}`;
}

function strangerPrompt(existingNames: string[]) {
  return [
    {
      role: 'system' as const,
      content:
        'You invent a travelling visitor for a cozy pixel village. Reply with JSON only: ' +
        '{"name": string, "age": number, "occupation": string, "bio": "2 sentences", "traits": [string], ' +
        '"news": "one interesting piece of news the visitor brings from the outside world"}.',
    },
    {
      role: 'user' as const,
      content: `Villagers already in town: ${existingNames.join(', ') || 'none'}. Pick a different, short first name.`,
    },
  ];
}
