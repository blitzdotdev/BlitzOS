import { describe, expect, it } from 'vitest';
import {
  compareTaskOrder,
  generateTaskOrderKeyAtEnd,
  generateTaskOrderKeyAtStart,
  generateTaskOrderKeyBetween,
  TASK_ORDER_MIN_KEY,
} from '../src/task-order';

/** Deterministic jitter so ordering assertions do not depend on Math.random. */
const fixedRandom = (value: number) => () => value;

describe('generateTaskOrderKeyBetween', () => {
  it('produces a key between two neighbours', () => {
    const a = generateTaskOrderKeyBetween(null, null);
    const c = generateTaskOrderKeyBetween(a, null);
    const b = generateTaskOrderKeyBetween(a, c);
    expect(a < b).toBe(true);
    expect(b < c).toBe(true);
  });

  it('keeps inserting between the same pair without collapsing', () => {
    let low = generateTaskOrderKeyBetween(null, null);
    const high = generateTaskOrderKeyBetween(low, null);
    const inserted: string[] = [];
    for (let index = 0; index < 40; index += 1) {
      const next = generateTaskOrderKeyBetween(low, high);
      expect(low < next).toBe(true);
      expect(next < high).toBe(true);
      inserted.push(next);
      low = next;
    }
    expect(new Set(inserted).size).toBe(inserted.length);
  });

  it('appends after a key without renumbering anything', () => {
    const first = generateTaskOrderKeyBetween(null, null);
    const second = generateTaskOrderKeyBetween(first, null);
    const third = generateTaskOrderKeyBetween(second, null);
    expect([first, second, third]).toEqual([...[first, second, third]].sort());
  });

  it('prepends before the smallest key', () => {
    const first = generateTaskOrderKeyBetween(null, null);
    const before = generateTaskOrderKeyBetween(null, first);
    expect(before < first).toBe(true);
  });

  it('rejects out-of-sequence neighbours instead of producing a bogus key', () => {
    const low = generateTaskOrderKeyBetween(null, null);
    const high = generateTaskOrderKeyBetween(low, null);
    expect(() => generateTaskOrderKeyBetween(high, low)).toThrow(/out of sequence/);
  });

  it('never returns a key ending in the lowest digit, so a midpoint always exists', () => {
    let key = generateTaskOrderKeyBetween(null, null);
    for (let index = 0; index < 60; index += 1) {
      expect(key.endsWith('0')).toBe(false);
      key = generateTaskOrderKeyBetween(null, key);
    }
  });

  it('separates concurrent inserts at the same position via jitter', () => {
    const low = generateTaskOrderKeyBetween(null, null);
    const high = generateTaskOrderKeyBetween(low, null);
    const a = generateTaskOrderKeyBetween(low, high, fixedRandom(0.1));
    const b = generateTaskOrderKeyBetween(low, high, fixedRandom(0.9));
    expect(a).not.toBe(b);
    for (const key of [a, b]) {
      expect(low < key).toBe(true);
      expect(key < high).toBe(true);
    }
  });
});

describe('generateTaskOrderKeyAtEnd / AtStart', () => {
  it('sorts after every existing key', () => {
    const keys = ['1', '2', '5'];
    const end = generateTaskOrderKeyAtEnd(keys);
    expect(keys.every((key) => key < end)).toBe(true);
  });

  it('sorts before every existing key', () => {
    const keys = ['2', '5'];
    const start = generateTaskOrderKeyAtStart(keys);
    expect(keys.every((key) => start < key)).toBe(true);
  });

  it('falls back to the minimum key for an empty list', () => {
    expect(generateTaskOrderKeyAtEnd([])).toBe(TASK_ORDER_MIN_KEY);
    expect(generateTaskOrderKeyAtStart([])).toBe(TASK_ORDER_MIN_KEY);
  });

  it('ignores empty keys from malformed rows', () => {
    const end = generateTaskOrderKeyAtEnd(['', '2']);
    expect('2' < end).toBe(true);
  });
});

describe('compareTaskOrder', () => {
  it('orders by key, then by id so equal keys never flip', () => {
    const rows = [
      { order: '2', id: 'b' },
      { order: '1', id: 'z' },
      { order: '2', id: 'a' },
    ];
    expect([...rows].sort(compareTaskOrder).map((row) => row.id)).toEqual(['z', 'a', 'b']);
  });

  it('is stable for identical entries', () => {
    expect(compareTaskOrder({ order: '1', id: 'a' }, { order: '1', id: 'a' })).toBe(0);
  });
});

describe('generateTaskOrderKeyBetween property checks', () => {
  // Deterministic PRNG so a failure reproduces exactly.
  const makeRandom = (seed: number) => {
    let state = seed;
    return () => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state / 2147483648;
    };
  };

  it('stays strictly between its neighbours under jitter, including prefix neighbours', () => {
    // Regression: midpoint may return a strict prefix of `after` (between "5"
    // and "6X" it returns "6"), and appending a jitter digit to a prefix used
    // to jump past the neighbour — "6t" sorts after "6X".
    for (let seed = 1; seed <= 200; seed += 1) {
      const random = makeRandom(seed);
      for (const [before, after] of [
        ['5', '6X'],
        ['5Z', '6X'],
        ['1', '1X'],
        ['1', '10X'],
        ['A', 'AB'],
        ['zz', 'zzz'],
      ] as const) {
        const key = generateTaskOrderKeyBetween(before, after, random);
        expect(before < key, `${before} < ${key} (after=${after}, seed=${seed})`).toBe(true);
        expect(key < after, `${key} < ${after} (before=${before}, seed=${seed})`).toBe(true);
      }
    }
  });

  it('keeps a random insert sequence in the order the user asked for', () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const random = makeRandom(seed);
      // `order` is the list as the user sees it; each step inserts at a random
      // slot and the generated keys must reproduce exactly that arrangement.
      let keys: string[] = [generateTaskOrderKeyBetween(null, null, random)];
      for (let step = 0; step < 40; step += 1) {
        const at = Math.floor(random() * (keys.length + 1));
        const before = at === 0 ? null : (keys[at - 1] ?? null);
        const after = at >= keys.length ? null : (keys[at] ?? null);
        const key = generateTaskOrderKeyBetween(before, after, random);
        keys = [...keys.slice(0, at), key, ...keys.slice(at)];
      }
      const sorted = [...keys].sort();
      expect(sorted, `seed ${seed}`).toEqual(keys);
      expect(new Set(keys).size, `seed ${seed} produced a duplicate key`).toBe(keys.length);
    }
  });

  it('never emits a key ending in the lowest digit, so the next midpoint exists', () => {
    for (let seed = 1; seed <= 100; seed += 1) {
      const random = makeRandom(seed);
      let previous = generateTaskOrderKeyBetween(null, null, random);
      for (let step = 0; step < 30; step += 1) {
        const key = generateTaskOrderKeyBetween(previous, null, random);
        expect(key.endsWith('0'), `${key} (seed ${seed})`).toBe(false);
        previous = key;
      }
    }
  });
});
