/** Memory embeddings are shared by reference (saves, autosave), so the type forbids editing them in place. */
import { describe, expect, it } from 'vitest';
import type { Memory } from '../../src/shared/types.ts';

function editInPlace(m: Memory): void {
  // @ts-expect-error read-only: replace the vector instead of writing into it
  m.embedding![0] = 1;
  // @ts-expect-error read-only: no push / sort / fill on a shared vector
  m.embedding!.push(1);
}

describe('Memory.embedding', () => {
  it('can be replaced or cleared, but not edited in place (checked by npm run typecheck)', () => {
    const m: Memory = {
      id: 'ada-m1',
      villagerId: 'ada',
      createdAt: 0,
      lastAccessedAt: 0,
      kind: 'observation',
      text: 'x',
      importance: 1,
      keywords: [],
      meta: {},
      embedding: [0.6, 0.8],
    };
    const shared = m.embedding;
    m.embedding = [1, 0];
    m.embedding = undefined;
    expect(shared).toEqual([0.6, 0.8]);
    expect(typeof editInPlace).toBe('function');
  });
});
