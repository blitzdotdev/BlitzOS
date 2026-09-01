import { describe, expect, it, vi } from 'vitest';

import { runWithRetry } from '../src/lib/async-retry';

describe('runWithRetry', () => {
  it('retries a failed run until it succeeds', async () => {
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('stale'))
      .mockResolvedValueOnce('fresh');

    await expect(
      runWithRetry({ run, shouldRetry: (_error, attempt) => attempt === 0 })
    ).resolves.toBe('fresh');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('rethrows the error once shouldRetry declines', async () => {
    const error = new Error('nope');
    const run = vi.fn(async () => {
      throw error;
    });

    await expect(runWithRetry({ run, shouldRetry: () => false })).rejects.toBe(error);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('returns the stale result instead of retrying when the operation is obsolete', async () => {
    let stale = false;
    const run = vi.fn(async () => {
      throw new Error('try again');
    });

    const result = await runWithRetry<string | null>({
      run,
      isStale: () => stale,
      staleResult: () => null,
      shouldRetry: () => {
        stale = true;
        return true;
      },
    });

    expect(result).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
  });
});
