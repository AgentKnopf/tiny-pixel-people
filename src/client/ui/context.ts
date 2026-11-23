import type { LocationId, VillagerId } from '../../shared/types.ts';
import type { UiStore } from './store.ts';
import type { UiHost } from './types.ts';

export type ModalKind = 'map' | 'decorate' | 'backpack' | 'pet' | 'door-note';

/** Shared handles passed to every panel. */
export interface UiContext {
  store: UiStore;
  host: UiHost;
  select(id: VillagerId | null): void;
  openModal(kind: ModalKind, houseId?: LocationId): void;
  closeModal(): void;
  /** Download the replay after asking the server to save. */
  saveReplay(): void;
}
