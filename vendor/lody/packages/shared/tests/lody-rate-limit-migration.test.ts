import { describe, expect, it } from 'vitest';

import { normalizePersistedRateLimit } from '../src/acp/lody-rate-limit-migration';

describe('normalizePersistedRateLimit', () => {
  it('normalizes legacy provider scales, durations, and timestamps at the persistence boundary', () => {
    const normalized = normalizePersistedRateLimit('claude', 'claude', {
      planName: 'Claude Max',
      fiveHour: 0.55,
      sevenDay: 0.8,
      fiveHourResetAt: 1_784_505_071_000,
      sevenDayResetAt: 1_784_505_071,
    });

    expect(normalized).toMatchObject({
      limitId: 'claude',
      scope: { providerId: 'claude' },
      planName: 'Claude Max',
      windows: [
        {
          windowDurationSeconds: 18_000,
          resetsAtEpochSeconds: 1_784_505_071,
        },
        {
          windowDurationSeconds: 604_800,
          resetsAtEpochSeconds: 1_784_505_071,
        },
      ],
    });
    expect(normalized?.windows[0]?.usedPercent).toBeCloseTo(55);
    expect(normalized?.windows[1]?.usedPercent).toBeCloseTo(80);
  });

  it('preserves Grok sub-one-percent values and maps a single Codex window to weekly', () => {
    expect(
      normalizePersistedRateLimit('grok', 'grok', {
        sevenDay: 0.5,
        sevenDayResetAt: 1_784_505_071,
      })?.windows
    ).toEqual([
      {
        usedPercent: 0.5,
        windowDurationSeconds: 604_800,
        resetsAtEpochSeconds: 1_784_505_071,
      },
    ]);

    expect(
      normalizePersistedRateLimit('codex', 'codex', {
        fiveHour: 29,
        sevenDay: null,
        fiveHourResetAt: 1_784_505_071,
      })?.windows
    ).toEqual([
      {
        usedPercent: 29,
        windowDurationSeconds: 604_800,
        resetsAtEpochSeconds: 1_784_505_071,
      },
    ]);
  });
});
