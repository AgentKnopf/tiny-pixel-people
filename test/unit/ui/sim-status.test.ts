// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SimStatusMsg } from '../../../src/shared/protocol.ts';
import { mountUi, UiStore, type UiController } from '../../../src/client/ui/index.ts';
import { SIM_STATUS_STALE_MS } from '../../../src/client/ui/sim-status.ts';
import { makeHello } from './fixtures.ts';

let root: HTMLElement;
let ui: UiController;

const banner = () => root.querySelector<HTMLElement>('[data-testid="sim-status"]')!;
const status = (phase: SimStatusMsg['phase'], plansReady: number, villagers = 10) =>
  ({ type: 'sim.status', phase, plansReady, villagers }) satisfies SimStatusMsg;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('offline'))),
  );
  document.body.innerHTML = '<div id="ui"></div>';
  root = document.querySelector<HTMLElement>('#ui')!;
  ui = mountUi(root, { send: () => undefined }, new UiStore());
  ui.setConnectionStatus('connected');
  ui.handleMessage(makeHello());
});

afterEach(() => {
  ui.destroy();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('sim.status waking-up banner', () => {
  it('is hidden until the server reports wakingUp', () => {
    expect(banner().hidden).toBe(true);
  });

  it('shows plan progress while waking up and hides on running', () => {
    ui.handleMessage(status('wakingUp', 3));
    expect(banner().hidden).toBe(false);
    expect(banner().textContent).toContain('Villagers are waking up… (3/10 plans ready)');
    expect(root.querySelector<HTMLElement>('.sim-status-fill')!.style.width).toBe('30%');

    ui.handleMessage(status('wakingUp', 7));
    expect(banner().textContent).toContain('(7/10 plans ready)');

    ui.handleMessage(status('running', 10));
    expect(banner().hidden).toBe(true);
  });

  it('shows how many villagers are still planning while the clock runs', () => {
    ui.handleMessage(status('planning', 7));
    expect(banner().hidden).toBe(false);
    expect(banner().textContent).toContain('3 villagers still planning');
    expect(banner().textContent).not.toMatch(/waking up|plans ready/i);
    expect(banner().dataset.phase).toBe('planning');
    expect(root.querySelector<HTMLElement>('.sim-status-fill')!.style.width).toBe('70%');

    ui.handleMessage(status('planning', 9));
    expect(banner().textContent).toContain('1 villager still planning');

    ui.handleMessage(status('running', 10));
    expect(banner().hidden).toBe(true);
  });

  it('marks only the waking-up phase as the clock waiting', () => {
    ui.handleMessage(status('wakingUp', 3));
    expect(banner().dataset.phase).toBe('wakingUp');
    ui.handleMessage(status('planning', 3));
    expect(banner().dataset.phase).toBe('planning');
    expect(banner().textContent).toContain('7 villagers still planning');
  });

  it('hides the planning banner once nobody is left planning', () => {
    ui.handleMessage(status('planning', 10));
    expect(banner().hidden).toBe(true);
  });

  it('hides the planning banner when updates stop arriving', () => {
    ui.handleMessage(status('planning', 2));
    vi.advanceTimersByTime(SIM_STATUS_STALE_MS - 1000);
    expect(banner().hidden).toBe(false);
    vi.advanceTimersByTime(2000);
    expect(banner().hidden).toBe(true);
  });

  it('does not block the rest of the UI', () => {
    ui.handleMessage(status('wakingUp', 0));
    expect(root.querySelector('.modal-backdrop:not([hidden])')).toBeNull();
    expect(banner().classList.contains('panel')).toBe(false);
    const pause = root.querySelector<HTMLButtonElement>('[data-testid="btn-pause"]')!;
    expect(pause.disabled).toBe(false);
  });

  it('hides while disconnected and when updates stop arriving', () => {
    ui.handleMessage(status('wakingUp', 2));
    ui.setConnectionStatus('disconnected, retrying…');
    expect(banner().hidden).toBe(true);
    ui.setConnectionStatus('connected');
    expect(banner().hidden).toBe(false);

    vi.advanceTimersByTime(SIM_STATUS_STALE_MS - 1000);
    ui.handleMessage(status('wakingUp', 4));
    vi.advanceTimersByTime(SIM_STATUS_STALE_MS - 1000);
    expect(banner().hidden).toBe(false);
    vi.advanceTimersByTime(2000);
    expect(banner().hidden).toBe(true);
  });
});
