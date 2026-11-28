import { INFLUENCE_RAIN_HOURS, type WeatherOutcomes } from '../../shared/influence.ts';
import type { InfluenceId } from '../../shared/influence.ts';
import type { InfluenceHandler, InfluenceService } from '../sim/influence.ts';
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
