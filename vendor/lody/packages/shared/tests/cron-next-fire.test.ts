import { describe, expect, it } from 'vitest';
import { nextCronFireMs } from '../src/cron-next-fire';

/** Local-timezone-safe epoch ms for a given local date/time. */
function localMs(year: number, month1: number, day: number, hour: number, minute: number): number {
  return new Date(year, month1 - 1, day, hour, minute, 0, 0).getTime();
}

describe('nextCronFireMs', () => {
  it('resolves a fully-specified one-shot cron to its exact time', () => {
    // `39 11 3 7 *` = 11:39 on July 3 (any weekday).
    const from = localMs(2026, 7, 1, 9, 0);
    const next = nextCronFireMs('39 11 3 7 *', from);
    expect(next).toBe(localMs(2026, 7, 3, 11, 39));
  });

  it('handles leading-zero fields', () => {
    const from = localMs(2026, 7, 1, 0, 0);
    const next = nextCronFireMs('17 08 03 07 *', from);
    expect(next).toBe(localMs(2026, 7, 3, 8, 17));
  });

  it('resolves a daily recurring cron to the next occurrence after now', () => {
    // `0 9 * * *` = every day at 09:00. From 10:00 -> tomorrow 09:00.
    const from = localMs(2026, 7, 1, 10, 0);
    const next = nextCronFireMs('0 9 * * *', from);
    expect(next).toBe(localMs(2026, 7, 2, 9, 0));
  });

  it('fires later the same day when the time has not passed yet', () => {
    const from = localMs(2026, 7, 1, 8, 0);
    const next = nextCronFireMs('0 9 * * *', from);
    expect(next).toBe(localMs(2026, 7, 1, 9, 0));
  });

  it('resolves step expressions (*/n)', () => {
    // `*/5 * * * *` = every 5 minutes. From 10:02 -> 10:05.
    const from = localMs(2026, 7, 1, 10, 2);
    expect(nextCronFireMs('*/5 * * * *', from)).toBe(localMs(2026, 7, 1, 10, 5));
  });

  it('resolves ranges (a-b)', () => {
    // `0 9-17 * * *` = top of the hour, 09:00..17:00. From 09:30 -> 10:00.
    const from = localMs(2026, 7, 1, 9, 30);
    expect(nextCronFireMs('0 9-17 * * *', from)).toBe(localMs(2026, 7, 1, 10, 0));
  });

  it('resolves weekday ranges (Mon-Fri)', () => {
    // `0 9 * * 1-5` = 09:00 on weekdays. 2026-07-04 is a Saturday, so from Sat 10:00
    // the next fire is Monday 2026-07-06 09:00.
    const from = localMs(2026, 7, 4, 10, 0);
    expect(nextCronFireMs('0 9 * * 1-5', from)).toBe(localMs(2026, 7, 6, 9, 0));
  });

  it('resolves comma lists', () => {
    // `0 9 * * 1,3,5` = 09:00 Mon/Wed/Fri. 2026-07-01 is a Wednesday.
    const from = localMs(2026, 7, 1, 10, 0);
    // Next is Friday 2026-07-03 09:00.
    expect(nextCronFireMs('0 9 * * 1,3,5', from)).toBe(localMs(2026, 7, 3, 9, 0));
  });

  it('returns undefined for malformed or out-of-range expressions', () => {
    const from = localMs(2026, 7, 1, 0, 0);
    expect(nextCronFireMs('61 11 3 7 *', from)).toBeUndefined();
    expect(nextCronFireMs('39 11 3', from)).toBeUndefined();
    expect(nextCronFireMs('', from)).toBeUndefined();
    expect(nextCronFireMs('5-3 * * * *', from)).toBeUndefined();
    expect(nextCronFireMs('*/0 * * * *', from)).toBeUndefined();
  });

  it('returns undefined for a date that never occurs (Feb 31)', () => {
    const from = localMs(2026, 1, 1, 0, 0);
    expect(nextCronFireMs('0 0 31 2 *', from)).toBeUndefined();
  });
});

describe('nextCronFireMs — timezone', () => {
  // These pass explicit UTC epochs + an explicit IANA zone, so the result is independent of
  // the machine running the test. "0 9 * * *" fires at 09:00 in the given zone.
  const utc = (y: number, mo: number, d: number, h: number, mi: number) => Date.UTC(y, mo - 1, d, h, mi);

  it('resolves the cron in the given zone, not the runner local zone', () => {
    // Summer: America/New_York is EDT (UTC-4), so 09:00 local = 13:00 UTC.
    const from = utc(2026, 7, 1, 0, 0); // 2026-06-30 20:00 EDT
    expect(nextCronFireMs('0 9 * * *', from, 'America/New_York')).toBe(utc(2026, 7, 1, 13, 0));
    // Asia/Shanghai (UTC+8, no DST): 09:00 local = 01:00 UTC.
    expect(nextCronFireMs('0 9 * * *', from, 'Asia/Shanghai')).toBe(utc(2026, 7, 1, 1, 0));
  });

  it('the same cron in two zones differs by their offset', () => {
    const from = utc(2026, 7, 1, 0, 0);
    const ny = nextCronFireMs('0 9 * * *', from, 'America/New_York')!;
    const sh = nextCronFireMs('0 9 * * *', from, 'Asia/Shanghai')!;
    // 09:00 EDT (13:00 UTC) is 12h after 09:00 CST (01:00 UTC).
    expect(ny - sh).toBe(12 * 3_600_000);
  });

  it('accounts for DST: same wall-clock time shifts UTC across the year', () => {
    // Winter: America/New_York is EST (UTC-5), so 09:00 local = 14:00 UTC (vs 13:00 in summer).
    const from = utc(2026, 1, 1, 0, 0);
    expect(nextCronFireMs('0 9 * * *', from, 'America/New_York')).toBe(utc(2026, 1, 1, 14, 0));
  });

  it('crosses a spring-forward DST boundary correctly', () => {
    // US DST 2026 begins Sun 2026-03-08. A daily 09:00 job spanning the boundary stays at
    // 09:00 local: 2026-03-07 is EST (14:00 UTC), 2026-03-09 is EDT (13:00 UTC).
    expect(nextCronFireMs('0 9 * * *', utc(2026, 3, 7, 15, 0), 'America/New_York')).toBe(
      utc(2026, 3, 8, 13, 0) // Mar 8 09:00 EDT
    );
  });

  it('falls back to the local zone for an unusable timezone', () => {
    const from = localMs(2026, 7, 1, 8, 0);
    expect(nextCronFireMs('0 9 * * *', from, 'Not/AZone')).toBe(nextCronFireMs('0 9 * * *', from));
  });
});
