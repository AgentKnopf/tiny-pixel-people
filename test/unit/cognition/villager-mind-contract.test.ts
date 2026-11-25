import { describe, expectTypeOf, it } from 'vitest';
import type { Memory } from '../../../src/shared/types.ts';
import type { VillagerMind } from '../../../src/server/cognition/types.ts';

describe('VillagerMind contract', () => {
  it('has an optional recentMemories(n) for callers that need only the newest memories', () => {
    // Checked by the typecheck: fails to compile while the method is missing.
    type Recent = NonNullable<VillagerMind['recentMemories']>;
    expectTypeOf<Parameters<Recent>>().toEqualTypeOf<[n: number]>();
    expectTypeOf<ReturnType<Recent>>().toEqualTypeOf<Memory[]>();
    const minimal: Pick<VillagerMind, 'recentMemories'> = {};
    void minimal;
  });
});
