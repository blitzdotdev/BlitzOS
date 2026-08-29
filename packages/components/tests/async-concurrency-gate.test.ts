import { describe, expect, it } from 'vitest';
import { createAsyncConcurrencyGate } from '../src/lib/async-concurrency-gate';

describe('createAsyncConcurrencyGate', () => {
  it('keeps concurrent tasks within the configured limit', async () => {
    const gate = createAsyncConcurrencyGate(2);
    let active = 0;
    let maxActive = 0;

    const tasks = Array.from({ length: 6 }, async (_, index) =>
      gate(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active -= 1;
        return index;
      })
    );

    await expect(Promise.all(tasks)).resolves.toEqual([0, 1, 2, 3, 4, 5]);
    expect(maxActive).toBe(2);
  });

  it('releases a slot when a task rejects', async () => {
    const gate = createAsyncConcurrencyGate(1);
    const order: string[] = [];

    const first = gate(async () => {
      order.push('first-start');
      throw new Error('failed');
    });
    const second = gate(async () => {
      order.push('second-start');
      return 'second';
    });

    await expect(first).rejects.toThrow('failed');
    await expect(second).resolves.toBe('second');
    expect(order).toEqual(['first-start', 'second-start']);
  });

  it('reserves a released slot for the next queued task', async () => {
    const gate = createAsyncConcurrencyGate(1);
    const order: string[] = [];
    let releaseFirst: () => void = () => {};
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = gate(async () => {
      order.push('first-start');
      await firstCanFinish;
      order.push('first-end');
    });
    const second = gate(async () => {
      order.push('second-start');
      await Promise.resolve();
      order.push('second-end');
    });

    await Promise.resolve();
    releaseFirst();
    const third = gate(async () => {
      order.push('third-start');
    });

    await Promise.all([first, second, third]);
    expect(order).toEqual([
      'first-start',
      'first-end',
      'second-start',
      'second-end',
      'third-start',
    ]);
  });

  it('rejects invalid limits', () => {
    expect(() => createAsyncConcurrencyGate(0)).toThrow(/positive integer/);
    expect(() => createAsyncConcurrencyGate(1.5)).toThrow(/positive integer/);
  });
});
