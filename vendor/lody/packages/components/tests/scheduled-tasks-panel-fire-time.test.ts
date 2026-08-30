import { describe, expect, it } from 'vitest';
import { resolveFireMs, type PendingScheduledTask } from '@lody/shared';

// A fixed reference time: 2026-07-03 16:25:12 local. Cron resolution is local-time based
// (nextCronFireMs reads local getHours/getMinutes), so build the expected times the same way.
const REF = new Date(2026, 6, 3, 16, 25, 12).getTime();
const at = (y: number, mo: number, d: number, h: number, mi: number) =>
  new Date(y, mo, d, h, mi, 0, 0).getTime();

/** Build a one-shot cron pinned to a specific minute/hour/day/month (fires once a year). */
function oneShotCron(overrides: Partial<PendingScheduledTask>): PendingScheduledTask {
  return {
    id: 'job',
    kind: 'cron',
    createdAtMs: REF,
    humanSchedule: '25 16 3 7 *',
    recurring: false,
    ...overrides,
  };
}

describe('resolveFireMs — one-shot cron created in the same minute it fires', () => {
  it('resolves to that minute (already past), not a year later, so the row hides', () => {
    // Regression: turn ended at 16:25:12 while scheduling "25 16 3 7 *" (fires 16:25:00).
    // Anchoring strictly after createdAtMs skipped to next July → "365 天后" and never hid.
    const task = oneShotCron({ createdAtMs: at(2026, 6, 3, 16, 25) + 12_000 });
    const fireMs = resolveFireMs(task, REF);
    expect(fireMs).toBe(at(2026, 6, 3, 16, 25)); // this year's 16:25, already in the past
    expect(fireMs! < REF).toBe(true); // → hidden by the fired-task filter
  });

  it('still shows an upcoming one-shot cron with its correct future fire time', () => {
    // Created at 16:20, scheduled for 16:25 the same day: resolves to today 16:25 (future).
    const task = oneShotCron({ createdAtMs: at(2026, 6, 3, 16, 20) });
    expect(resolveFireMs(task, at(2026, 6, 3, 16, 20))).toBe(at(2026, 6, 3, 16, 25));
  });

  it('recurring cron resolves to its next occurrence relative to now, never hiding', () => {
    const task = oneShotCron({ humanSchedule: '25 16 * * *', recurring: true });
    // now is 16:25:12, so today's 16:25 has passed → next is tomorrow 16:25.
    expect(resolveFireMs(task, REF)).toBe(at(2026, 6, 4, 16, 25));
  });
});
