import type { AnimalSpecies, AnimalState } from '../../shared/types.ts';
import { dayOf } from '../../shared/time.ts';
import { h, setText } from './dom.ts';
import type { UiStore } from './store.ts';

export const SPECIES_EMOJI: Record<AnimalSpecies, string> = {
  cow: '🐄',
  sheep: '🐑',
  chicken: '🐔',
  lion: '🦁',
  elephant: '🐘',
  giraffe: '🦒',
  zebra: '🦓',
  penguin: '🐧',
  monkey: '🐒',
  panda: '🐼',
  flamingo: '🦩',
  kangaroo: '🦘',
  polar_bear: '🐻‍❄️',
  hippo: '🦛',
  crocodile: '🐊',
  deer: '🦌',
  rabbit: '🐇',
  squirrel: '🐿️',
  hedgehog: '🦔',
  fox: '🦊',
  bird: '🐦',
  duck: '🦆',
  crow: '🐦‍⬛',
};

const STAGE_LABEL = { baby: 'Baby', adult: 'Adult', elder: 'Elder' } as const;
const STATUS_LABEL: Record<AnimalState['status'], string> = {
  idle: 'resting',
  walking: 'wandering about',
  eating: 'eating',
  sleeping: 'sleeping 💤',
  flying: 'flying',
  leaving: 'leaving the farm',
};

export function speciesName(species: AnimalSpecies): string {
  const s = species.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Whole game days since birth. */
export function animalAgeDays(a: AnimalState, now: number): number | null {
  return a.bornAt == null ? null : Math.max(0, dayOf(now) - dayOf(a.bornAt));
}

/**
 * Small card shown when an animal is clicked (spec v2 §13): species, name, and for farm and zoo
 * animals the stage and age in days. Forest animals and the crow show only species and name.
 */
export function createAnimalCard(store: UiStore, onClose: () => void): HTMLElement {
  const emoji = h('span', { class: 'animal-emoji', 'aria-hidden': 'true' });
  const name = h('h2', { class: 'animal-name', 'data-testid': 'animal-name' });
  const species = h('div', { class: 'animal-species', 'data-testid': 'animal-species' });
  const details = h('div', { class: 'animal-details', 'data-testid': 'animal-details' });
  const status = h('div', { class: 'animal-status label-note', 'data-testid': 'animal-status' });
  const where = h('div', { class: 'label' });
  const el = h(
    'aside',
    {
      class: 'panel animal-card',
      id: 'animal-card',
      hidden: true,
      'aria-label': 'Animal',
      'data-testid': 'animal-card',
    },
    h(
      'button',
      { class: 'close', 'aria-label': 'Close animal card', 'data-testid': 'animal-close', onclick: onClose },
      '×',
    ),
    h('header', null, emoji, h('div', null, name, species)),
    details,
    status,
    where,
  );

  const render = () => {
    const a = store.selectedAnimalId ? store.animals.get(store.selectedAnimalId) : undefined;
    el.hidden = !a;
    if (!a) return;
    setText(emoji, SPECIES_EMOJI[a.species] ?? '🐾');
    const kind = speciesName(a.species);
    setText(name, a.name ?? kind);
    setText(species, a.name ? kind : a.group === 'zoo' ? 'Zoo animal' : '');
    const ambient = a.group === 'ambient';
    const parts: string[] = [];
    if (!ambient) {
      if (a.stage) parts.push(STAGE_LABEL[a.stage]);
      if (a.sex) parts.push(a.sex === 'female' ? '♀ female' : '♂ male');
      const age = animalAgeDays(a, store.time);
      if (age !== null) parts.push(`${age} day${age === 1 ? '' : 's'} old`);
    }
    setText(details, parts.join(' · '));
    details.hidden = parts.length === 0;
    setText(status, ambient ? '' : `Now ${STATUS_LABEL[a.status] ?? a.status}`);
    status.hidden = ambient;
    setText(where, store.locationName(a.homeId));
  };
  store.subscribe(['animalSelection', 'animals', 'hello'], render);
  render();
  return el;
}
