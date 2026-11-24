import type { VillagerId } from '../../shared/types.ts';
import type { UiStore } from './store.ts';
import type { UiHost } from './types.ts';
import type { WalkIn } from './walk-in.ts';

export type ModalKind =
  'map' | 'decorate' | 'backpack' | 'pet' | 'door-note' | 'letters' | 'notice-board' | 'keep' | 'villagers';

/** Shared handles passed to every panel. */
export interface UiContext {
  store: UiStore;
  host: UiHost;
  select(id: VillagerId | null): void;
  /** `arg` is the house id for 'door-note' and the starting tab for 'letters'. */
  openModal(kind: ModalKind, arg?: string): void;
  closeModal(): void;
  /** Re-render the open modal if its key changed. */
  refreshModal(): void;
  /** Walk to a building's door, or a venue's entry, if needed, then go inside, buy or ride. */
  walkIn: WalkIn;
  /** Download the replay after asking the server to save. */
  saveReplay(): void;
}
