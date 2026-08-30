import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getServerNow,
  getServerTimeOffset,
  resetTimeSync,
  syncTime,
} from '../src/time-sync';

describe('time sync', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetTimeSync();
  });

  it('keeps calibrated timestamps integral when the RTT midpoint is fractional', async () => {
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_001)
      .mockReturnValue(2_000);

    await syncTime(async () => 1_500);

    expect(getServerTimeOffset()).toBe(500);
    expect(getServerNow()).toBe(2_500);
    expect(Number.isInteger(getServerNow())).toBe(true);
  });
});
