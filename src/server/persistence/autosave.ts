import type { GameMinutes } from '../../shared/types.ts';
import { createLogger } from '../log.ts';
import type { SaveData, SaveStore } from './types.ts';

const log = createLogger('autosave');

export interface AutosaverOptions {
  store: Pick<SaveStore, 'save'>;
  /** Config persistence.autosaveGameMinutes; 0 disables periodic saves. */
  intervalGameMinutes: number;
  /** Builds the current SaveData (engine + minds + player). */
  collect: () => SaveData;
}

/**
 * Periodic autosave driven by game time. Call `tick(now)` from the sim loop (cheap; at most one save in flight),
 * `saveNow()` for the save command and on shutdown.
 */
export class Autosaver {
  private lastSaveAt: GameMinutes | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(private readonly opts: AutosaverOptions) {}

  tick(now: GameMinutes): void {
    if (this.opts.intervalGameMinutes <= 0 || this.inFlight) return;
    if (this.lastSaveAt === null) {
      this.lastSaveAt = now;
      return;
    }
    if (now - this.lastSaveAt < this.opts.intervalGameMinutes) return;
    this.lastSaveAt = now;
    void this.saveNow().catch((err: unknown) => log.error(`autosave failed: ${(err as Error).message}`));
  }

  async saveNow(): Promise<void> {
    if (this.inFlight) await this.inFlight.catch(() => undefined);
    const data = this.opts.collect();
    this.lastSaveAt = data.time;
    const p = this.opts.store.save(data);
    this.inFlight = p;
    try {
      await p;
      log.info(`saved at game time ${data.time}`);
    } finally {
      if (this.inFlight === p) this.inFlight = null;
    }
  }
}

/** Save once on SIGINT/SIGTERM, then run `onExit` (e.g. close the server and exit). */
export function installShutdownSave(saveNow: () => Promise<void>, onExit: () => Promise<void> | void): void {
  let done = false;
  const handler = (signal: string) => {
    if (done) return;
    done = true;
    log.info(`${signal}: saving before exit`);
    saveNow()
      .catch((err: unknown) => log.error(`shutdown save failed: ${(err as Error).message}`))
      .finally(() => void onExit());
  };
  process.once('SIGINT', () => handler('SIGINT'));
  process.once('SIGTERM', () => handler('SIGTERM'));
}
