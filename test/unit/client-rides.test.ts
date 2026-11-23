import { describe, expect, it } from 'vitest';
import type { RideState, TrainState, WorldMap } from '../../src/shared/types.ts';
import {
  COASTER_CARS,
  alongLoop,
  coasterCars,
  rideFrame,
  ridingIds,
  traceLoop,
  trackMasks,
  trainPose,
} from '../../src/client/render/rides.ts';
import { placeLabel } from '../../src/client/render/renderer.ts';

/** 6×4 loop of coaster tiles inside an 8×6 map, the way the art map paints it. */
function coasterMap(): { map: WorldMap; names: Map<number, string> } {
  const W = 8;
  const H = 6;
  const rows = ['........', '.6aaaac.', '.5....5.', '.3aaaa9.', '........', '........'];
  const code: Record<string, number> = { '6': 6, a: 10, c: 12, '5': 5, '3': 3, '9': 9 };
  const names = new Map<number, string>();
  for (const n of [3, 5, 6, 9, 10, 12]) names.set(100 + n, `coaster_${n}`);
  const decor: number[] = [];
  for (const r of rows) for (const ch of r) decor.push(ch in code ? 100 + code[ch]! : -1);
  const map = {
    width: W,
    height: H,
    tileSize: 16,
    layers: { ground: [], decor, overhead: [] },
    railway: { rows: [3, 5], platform: { x: 0, y: 1, w: 8, h: 2 } },
  } as unknown as WorldMap;
  return { map, names };
}

const ride = (status: RideState['status'], riders: string[] = []): RideState => ({
  locationId: 'rollercoaster',
  status,
  riders,
  queue: [],
  cycleEndsAt: null,
});

describe('rollercoaster track', () => {
  it('traces the closed loop from the boarding point, leaving east', () => {
    const { map, names } = coasterMap();
    const masks = trackMasks(map, names, { x: 1, y: 1, w: 6, h: 3 });
    expect(masks.size).toBe(14);
    const loop = traceLoop(masks, map.width, { x: 3, y: 0 })!;
    expect(loop).toHaveLength(14);
    expect(loop[0]).toEqual({ x: 3, y: 1 });
    expect(loop[1]).toEqual({ x: 4, y: 1 });
    expect(alongLoop(loop, 3.5)).toEqual({ pos: { x: 6, y: 1.5 }, heading: 'south' });
    expect(alongLoop(loop, 14 + 0.25).pos).toEqual({ x: 3.25, y: 1 });
  });

  it('rejects broken track', () => {
    const { map, names } = coasterMap();
    const masks = trackMasks(map, names, { x: 1, y: 1, w: 6, h: 3 });
    masks.delete(1 * map.width + 6);
    expect(traceLoop(masks, map.width, { x: 3, y: 0 })).toBeNull();
  });

  it('parks the cars at the boarding point until the ride runs', () => {
    const { map, names } = coasterMap();
    const loop = traceLoop(trackMasks(map, names, { x: 1, y: 1, w: 6, h: 3 }), map.width, { x: 3, y: 0 })!;
    const parked = coasterCars(loop, ride('idle'), 5000);
    expect(parked).toHaveLength(COASTER_CARS);
    expect(parked).toEqual(coasterCars(loop, ride('idle'), 9000));
    expect(coasterCars(loop, ride('running'), 5000)[0]).not.toEqual(
      coasterCars(loop, ride('running'), 5500)[0],
    );
  });
});

describe('ride frames and riders', () => {
  it('animates only running rides and hides their riders', () => {
    expect(rideFrame(ride('idle'), 8, 4, 1000)).toBeNull();
    expect(rideFrame(ride('running'), 8, 4, 1000)).toBe(4);
    expect(rideFrame(ride('running'), 8, 4, 2250)).toBe(1);
    expect([...ridingIds([ride('running', ['a', 'b']), ride('idle', ['c'])])]).toEqual(['a', 'b']);
  });
});

describe('train', () => {
  const { map } = coasterMap();
  const t = (status: TrainState['status']): TrainState => ({
    status,
    arrivesAt: 600,
    departsAt: 620,
    arriving: [],
    departing: [],
  });

  it('enters from the east, stops centred on the platform and leaves west', () => {
    expect(trainPose(t('away'), 600, map)).toBeNull();
    expect(trainPose(t('arriving'), 595, map)).toEqual({ x: 8, row: 4, moving: true });
    const mid = trainPose(t('arriving'), 597.5, map)!;
    expect(mid.x).toBeLessThan(8);
    expect(mid.x).toBeGreaterThan(-4);
    // 16-tile train on an 8-tile platform: centred means starting 4 tiles before it.
    expect(trainPose(t('arriving'), 600, map)).toEqual({ x: -4, row: 4, moving: false });
    expect(trainPose(t('boarding'), 610, map)).toEqual({ x: -4, row: 4, moving: false });
    expect(trainPose(t('departing'), 622, map)!.x).toBeLessThan(-4);
    expect(trainPose(t('departing'), 625, map)!.x).toBe(-17);
  });

  it('needs a railway', () => {
    const noRail = { ...map, railway: undefined } as WorldMap;
    expect(trainPose(t('boarding'), 610, noRail)).toBeNull();
  });
});

describe('name tag placement', () => {
  it('moves a covered tag down, then drops it only when allowed', () => {
    const placed: { x: number; y: number; w: number; h: number }[] = [];
    const tag = { x: 0, y: 0, w: 40, h: 10 };
    expect(placeLabel(tag, placed, true)).toBe(0);
    expect(placeLabel(tag, placed, true)).toBe(11);
    expect(placeLabel(tag, placed, true)).toBe(22);
    expect(placeLabel(tag, placed, true)).toBeNull();
    expect(placeLabel(tag, placed, false)).toBe(0);
    expect(placeLabel({ ...tag, x: 60 }, placed, true)).toBe(0);
  });
});
