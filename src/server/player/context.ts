import { DEFAULT_CONFIG, type AppConfig } from '../config.ts';
import type { ServerMessage } from '../../shared/protocol.ts';
import { PLAYER_HOME_ID, type Location, type LocationId, type VillagerState } from '../../shared/types.ts';
import type { WorldCatalogs } from './catalog.ts';
import type { PlayerHost } from './host.ts';

export interface PlayerWorldConfig {
  player: AppConfig['player'];
  economy: AppConfig['economy'];
  world: AppConfig['world'];
  /** Villager cap including strangers (spec: 20). */
  maxVillagers?: number;
  // v2 sections (spec v2 §12); missing ones use the defaults.
  zoo?: AppConfig['zoo'];
  train?: AppConfig['train'];
  visitors?: AppConfig['visitors'];
  hotel?: AppConfig['hotel'];
  interiors?: AppConfig['interiors'];
  post?: AppConfig['post'];
}

/** Shared plumbing for the WP8 controllers. */
export class Ctx {
  private seq = 0;

  constructor(
    readonly host: PlayerHost,
    readonly cfg: PlayerWorldConfig,
    readonly catalogs: WorldCatalogs,
  ) {}

  get zoo(): AppConfig['zoo'] {
    return this.cfg.zoo ?? DEFAULT_CONFIG.zoo;
  }

  get train(): AppConfig['train'] {
    return this.cfg.train ?? DEFAULT_CONFIG.train;
  }

  get visitors(): AppConfig['visitors'] {
    return this.cfg.visitors ?? DEFAULT_CONFIG.visitors;
  }

  get hotel(): AppConfig['hotel'] {
    return this.cfg.hotel ?? DEFAULT_CONFIG.hotel;
  }

  get interiors(): AppConfig['interiors'] {
    return this.cfg.interiors ?? DEFAULT_CONFIG.interiors;
  }

  get post(): AppConfig['post'] {
    return this.cfg.post ?? DEFAULT_CONFIG.post;
  }

  get maxVillagers(): number {
    return this.cfg.maxVillagers ?? 20;
  }

  /** Unique across restarts because it embeds the game time. */
  id(prefix: string): string {
    return `${prefix}_${Math.floor(this.host.now())}_${++this.seq}`;
  }

  emit(msg: ServerMessage): void {
    this.host.emit(msg);
  }

  toast(icon: string, text: string): void {
    this.emit({ type: 'toast', icon, text });
  }

  log(text: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    this.emit({ type: 'log', level, text, time: this.host.now() });
  }

  location(id: LocationId): Location | undefined {
    return this.host.map.locations.find((l) => l.id === id);
  }

  home(): Location | undefined {
    return this.location(PLAYER_HOME_ID);
  }

  villager(id: string): VillagerState | undefined {
    return this.host.villagers().find((v) => v.id === id);
  }

  awake(): VillagerState[] {
    return this.host.villagers().filter((v) => v.status !== 'sleeping');
  }

  nameOf(id: string): string {
    return this.host.profile(id)?.name ?? id;
  }
}
