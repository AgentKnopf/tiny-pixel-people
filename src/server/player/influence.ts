import type { LearnedFact } from '../cognition/types.ts';
import type { InfluenceHandler, InfluenceService } from '../sim/influence.ts';
import { awakeWindow, isAwakeAt } from '../sim/plan.ts';
import {
  INFLUENCE_RAIN_HOURS,
  RUMOUR_SOURCE_LABELS,
  type InfluenceId,
  type RumourOutcomes,
  type WeatherOutcomes,
} from '../../shared/influence.ts';
import { dayOf, MINUTES_PER_DAY } from '../../shared/time.ts';
import type {
  GameMinutes,
  MemoryId,
  VillagerId,
  VillagerProfile,
  VillagerState,
} from '../../shared/types.ts';
import type { RainWatcher, WeatherController } from './weather.ts';

/** The part of the engine's influence service the player world's endpoint handlers use. */
export type InfluenceRegistry = Pick<InfluenceService, 'register' | 'updateOutcomes'>;

type UpdateWeather = (id: InfluenceId, update: (o: WeatherOutcomes) => void) => void;

function rainWatcher(id: InfluenceId, update: UpdateWeather): RainWatcher {
  return {
    swapped: (blocks) => update(id, (o) => (o.swaps += blocks)),
    ended: (at) => update(id, (o) => (o.endedAt = at)),
  };
}

/** `POST /api/influence/weather` (spec §4.5): rain for 1-3 game hours, or clear, via the weather controller. */
export function weatherInfluence(
  weather: WeatherController,
  now: () => number,
  update: UpdateWeather,
): InfluenceHandler<'weather'> {
  return {
    check(body) {
      if (body.weather === 'clear') {
        if (!weather.raining) return { status: 409, error: 'not_raining' };
        const at = now();
        return {
          targets: [],
          text: 'The rain was cleared',
          outcomes: { endedAt: at, swaps: 0 },
          apply: () => {
            const rainId = weather.currentRainId();
            weather.stopRain();
            return { refs: rainId ? { worldEventId: rainId } : {} };
          },
        };
      }
      const { hours } = body;
      if (!Number.isInteger(hours) || hours < INFLUENCE_RAIN_HOURS.min || hours > INFLUENCE_RAIN_HOURS.max)
        return {
          status: 422,
          error: 'invalid',
          field: 'hours',
          message: `"hours" must be a whole number from ${INFLUENCE_RAIN_HOURS.min} to ${INFLUENCE_RAIN_HOURS.max}.`,
        };
      if (weather.raining) return { status: 409, error: 'already_raining' };
      return {
        targets: [],
        text: `It started raining for ${hours} ${hours === 1 ? 'hour' : 'hours'}`,
        outcomes: { startedAt: now(), swaps: 0 },
        apply: (id) => {
          const ev = weather.startRain(hours * 60, rainWatcher(id, update));
          return { refs: { worldEventId: ev.id } };
        },
      };
    },
    resume(entry) {
      // Only a rain that is still the current one is followed again; ended entries keep their outcomes.
      const rainId = entry.refs.worldEventId;
      if (entry.payload.weather !== 'rain' || entry.outcomes.endedAt !== undefined || !rainId) return;
      weather.watchRain(rainId, rainWatcher(entry.id, update));
    },
  };
}

type UpdateRumour = (id: InfluenceId, update: (o: RumourOutcomes) => void) => void;

/** What the rumour handler needs from the player world. */
export interface RumourDeps {
  now(): GameMinutes;
  villager(id: VillagerId): VillagerState | undefined;
  profile(id: VillagerId): VillagerProfile | undefined;
  nameOf(id: VillagerId): string;
  /**
   * Give `to` the rumour as heard from `label` and start tracking it; returns the origin id.
   * Never names the player in anything a villager can read.
   */
  tell(to: VillagerId, text: string, label: string, influenceId: InfluenceId): MemoryId;
  update: UpdateRumour;
}

export interface RumourInfluence {
  handler: InfluenceHandler<'rumour'>;
  /** A new hop of a tracked rumour (`Rumors.recordLearned` accepted it). */
  spread(fact: LearnedFact): void;
}

/** Next game minute the villager may be told something: now if only the status lags, else the next wake time. */
export function wakesAt(profile: VillagerProfile, now: GameMinutes): GameMinutes {
  if (isAwakeAt(profile, now)) return Math.floor(now) + 1;
  const t = dayOf(now) * MINUTES_PER_DAY + awakeWindow(profile).wake;
  return t > now ? t : t + MINUTES_PER_DAY;
}

/** `POST /api/influence/rumour` (spec §4.1): a rumour from an in-world source, spread by normal gossip. */
export function rumourInfluence(deps: RumourDeps): RumourInfluence {
  const byOrigin = new Map<MemoryId, InfluenceId>();
  return {
    handler: {
      check({ to, text, source }) {
        const villager = deps.villager(to);
        const profile = deps.profile(to);
        if (!villager || !profile)
          return { status: 422, error: 'invalid', field: 'to', message: `Unknown villager "${to}".` };
        if (!Object.hasOwn(RUMOUR_SOURCE_LABELS, source))
          return {
            status: 422,
            error: 'invalid',
            field: 'source',
            message: `"source" must be one of: ${Object.keys(RUMOUR_SOURCE_LABELS).join(', ')}.`,
          };
        const now = deps.now();
        if (villager.status === 'sleeping' || !isAwakeAt(profile, now))
          return { status: 409, error: 'asleep', wakesAt: wakesAt(profile, now) };
        const label = RUMOUR_SOURCE_LABELS[source];
        return {
          targets: [to],
          ...(profile.transient ? { visitor: true } : {}),
          text: `${label} told ${deps.nameOf(to)} a rumour: ${text}`,
          outcomes: { spreadTo: [] },
          apply: (id) => {
            const originId = deps.tell(to, text, label, id);
            byOrigin.set(originId, id);
            return { refs: { originId } };
          },
        };
      },
      resume(entry) {
        if (entry.refs.originId) byOrigin.set(entry.refs.originId, entry.id);
      },
    },
    spread(fact) {
      const id = byOrigin.get(fact.originId);
      if (id) deps.update(id, (o) => o.spreadTo.push({ from: fact.from, to: fact.to, tick: fact.at }));
    },
  };
}
