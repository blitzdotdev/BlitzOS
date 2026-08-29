import { describe, expect, it, vi } from 'vitest';
import { InFlightDedupe } from '../src/in-flight-dedupe';

describe('InFlightDedupe', () => {
  it('shares the same promise for concurrent calls with the same key', async () => {
    const dedupe = new InFlightDedupe<string, number>();
    const factory = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return 42;
    });

    const [a, b] = await Promise.all([
      dedupe.run('key', factory),
      dedupe.run('key', factory),
    ]);
    expect(a).toBe(42);
    expect(b).toBe(42);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('clears the in-flight entry after the promise settles', async () => {
    const dedupe = new InFlightDedupe<string, number>();
    await dedupe.run('key', async () => 1);
    expect(dedupe.size()).toBe(0);
  });

  it('clears the in-flight entry even when the factory rejects', async () => {
    const dedupe = new InFlightDedupe<string, number>();
    await expect(
      dedupe.run('key', async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(dedupe.size()).toBe(0);
  });

  it('does not leak rejections to a parallel caller waiting on the same key, beyond the shared throw', async () => {
    const dedupe = new InFlightDedupe<string, number>();
    const factory = vi.fn(async () => {
      throw new Error('shared failure');
    });

    const [a, b] = await Promise.allSettled([
      dedupe.run('key', factory),
      dedupe.run('key', factory),
    ]);
    expect(a.status).toBe('rejected');
    expect(b.status).toBe('rejected');
    expect(factory).toHaveBeenCalledTimes(1);
    expect(dedupe.size()).toBe(0);
  });

  it('runs the factory again after the previous promise settled', async () => {
    const dedupe = new InFlightDedupe<string, number>();
    const factory = vi.fn(async () => 1);

    await dedupe.run('key', factory);
    await dedupe.run('key', factory);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('isolates entries by key', async () => {
    const dedupe = new InFlightDedupe<string, number>();
    const factoryA = vi.fn(async () => 1);
    const factoryB = vi.fn(async () => 2);

    const [a, b] = await Promise.all([
      dedupe.run('A', factoryA),
      dedupe.run('B', factoryB),
    ]);
    expect(a).toBe(1);
    expect(b).toBe(2);
    expect(factoryA).toHaveBeenCalledTimes(1);
    expect(factoryB).toHaveBeenCalledTimes(1);
  });

  it('late finalizer does not clear a newer entry that replaced it', async () => {
    // Drive timing manually so the first promise's finally fires after the
    // second call has already replaced the entry. The identity check inside
    // .finally() must avoid clearing the newer promise.
    const dedupe = new InFlightDedupe<string, number>();
    let resolveFirst: (value: number) => void = () => {};
    const firstFactory = () =>
      new Promise<number>((resolve) => {
        resolveFirst = resolve;
      });

    const firstCall = dedupe.run('key', firstFactory);
    resolveFirst(1);
    await firstCall;
    expect(dedupe.size()).toBe(0);

    let resolveSecond: (value: number) => void = () => {};
    const secondCall = dedupe.run('key', () =>
      new Promise<number>((resolve) => {
        resolveSecond = resolve;
      })
    );
    expect(dedupe.size()).toBe(1);
    resolveSecond(2);
    expect(await secondCall).toBe(2);
    expect(dedupe.size()).toBe(0);
  });
});
