/**
 * Timing for the budget checks (spec v2 §16). Wall time also counts time the OS or the VM host
 * keeps the thread off the CPU (CPU steal, preemption), which stretches a 2 ms step to 20–30 ms
 * now and then on cloud machines. CPU time of this thread does not, so the max gates use it.
 */

/** CPU time of this thread in ms, or null before Node 22.19 / 23.9. */
export const threadCpuMs: (() => number) | null =
  typeof process.threadCpuUsage === 'function'
    ? () => {
        const u = process.threadCpuUsage();
        return (u.user + u.system) / 1000;
      }
    : null;

/**
 * Linux updates a thread's CPU time only at scheduler ticks and switches, so one reading can be
 * off by one tick (4 ms at HZ=250). Work shorter than about 10 ticks is timed in batches.
 */
export const CPU_TICK_MS = 4;

export interface Timing {
  wall: number;
  /** Thread CPU time, capped at the wall time; null where Node has no `process.threadCpuUsage`. */
  cpu: number | null;
}

/** Starts a timer; the returned function stops it. */
export function startTiming(): () => Timing {
  const cpu0 = threadCpuMs?.() ?? 0;
  const wall0 = performance.now();
  return () => {
    const wall = performance.now() - wall0;
    return { wall, cpu: threadCpuMs ? Math.min(wall, threadCpuMs() - cpu0) : null };
  };
}

/** Times `n` back-to-back runs of `fn` and returns the time of one run. */
export function timeEach(fn: () => void, n = 1): Timing {
  const stop = startTiming();
  for (let i = 0; i < n; i++) fn();
  const t = stop();
  return { wall: t.wall / n, cpu: t.cpu === null ? null : t.cpu / n };
}

export interface Max {
  max: number;
  /** Index of the slowest timing. */
  at: number;
  on: 'CPU' | 'wall';
}

/** The max on CPU time, or on wall time where CPU time is not available. */
export function cpuMax(ts: readonly Timing[]): Max {
  const on = ts.every((t) => t.cpu !== null) ? 'CPU' : 'wall';
  const xs = ts.map((t) => (on === 'CPU' ? t.cpu! : t.wall));
  const max = Math.max(...xs);
  return { max, at: xs.indexOf(max), on };
}

export function wallMax(ts: readonly Timing[]): Max {
  const xs = ts.map((t) => t.wall);
  const max = Math.max(...xs);
  return { max, at: xs.indexOf(max), on: 'wall' };
}

/** Spins on the CPU for `ms` of thread CPU time (wall time where CPU time is not available). */
export function busySpin(ms: number): void {
  const clock = threadCpuMs ?? (() => performance.now());
  const end = clock() + ms;
  while (clock() < end);
}

/** Blocks the thread for `ms` without using the CPU. */
export function blockingWait(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
