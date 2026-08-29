import { describe, expect, it } from 'vitest';

import {
  hasUnstartedTrailingUserTurn,
  isUnstartedTrailingDispatchPreStart,
  resolveUnstartedTrailingDispatchAtMs,
  UNSTARTED_TRAILING_USER_TURN_TIMEOUT_MS,
} from '../src/lib/session-dispatch-state';

const userTurn = (status?: string, read?: boolean) => ({
  role: 'user' as const,
  ...(status !== undefined ? { status: status as never } : {}),
  ...(read !== undefined ? { read } : {}),
});

const userTurnAt = (timestamp: string, status = 'pending') => ({
  role: 'user' as const,
  status: status as never,
  timestamp,
});

const assistantTurn = () => ({ role: 'assistant' as const });

describe('hasUnstartedTrailingUserTurn', () => {
  it('reports a trailing pending user turn as unstarted', () => {
    expect(hasUnstartedTrailingUserTurn([assistantTurn(), userTurn('pending')])).toBe(true);
  });

  it('reports a trailing seen user turn as unstarted', () => {
    expect(hasUnstartedTrailingUserTurn([userTurn('seen')])).toBe(true);
  });

  it('maps legacy read=false to pending', () => {
    expect(hasUnstartedTrailingUserTurn([userTurn(undefined, false)])).toBe(true);
  });

  it('stops reporting once the CLI takes ownership (processing)', () => {
    expect(hasUnstartedTrailingUserTurn([userTurn('processing')])).toBe(false);
  });

  it('stops reporting once the turn reaches a terminal status', () => {
    expect(hasUnstartedTrailingUserTurn([userTurn('handled')])).toBe(false);
    expect(hasUnstartedTrailingUserTurn([userTurn('failed')])).toBe(false);
    expect(hasUnstartedTrailingUserTurn([userTurn('canceled')])).toBe(false);
  });

  it('ignores steer-owned pending_apply guides', () => {
    expect(hasUnstartedTrailingUserTurn([userTurn('pending_apply')])).toBe(false);
  });

  it('ignores pending user turns that are no longer trailing', () => {
    // A completed conversation always ends with an assistant/terminal entry;
    // an older stuck 'pending' entry must not resurrect the starting label.
    expect(hasUnstartedTrailingUserTurn([userTurn('pending'), assistantTurn()])).toBe(false);
  });

  it('handles empty and missing history', () => {
    expect(hasUnstartedTrailingUserTurn([])).toBe(false);
    expect(hasUnstartedTrailingUserTurn(undefined)).toBe(false);
    expect(hasUnstartedTrailingUserTurn(null)).toBe(false);
  });
});

describe('resolveUnstartedTrailingDispatchAtMs', () => {
  it('returns the trailing unstarted user turn dispatch time', () => {
    const ts = '2026-07-23T00:00:00.000Z';
    expect(resolveUnstartedTrailingDispatchAtMs([userTurnAt(ts)])).toBe(Date.parse(ts));
  });

  it('returns null when there is no trailing unstarted user turn', () => {
    expect(
      resolveUnstartedTrailingDispatchAtMs([userTurnAt('2026-07-23T00:00:00Z', 'handled')])
    ).toBe(null);
    expect(resolveUnstartedTrailingDispatchAtMs([])).toBe(null);
  });

  it('returns null when the turn carries no parseable timestamp (cannot time-bound)', () => {
    expect(resolveUnstartedTrailingDispatchAtMs([userTurn('pending')])).toBe(null);
    expect(resolveUnstartedTrailingDispatchAtMs([userTurnAt('not-a-date')])).toBe(null);
  });
});

describe('isUnstartedTrailingDispatchPreStart', () => {
  const dispatchedAt = Date.parse('2026-07-23T00:00:00.000Z');

  it('is optimistic within the timeout window', () => {
    const now = dispatchedAt + UNSTARTED_TRAILING_USER_TURN_TIMEOUT_MS - 1;
    expect(isUnstartedTrailingDispatchPreStart([userTurnAt('2026-07-23T00:00:00.000Z')], now)).toBe(
      true
    );
  });

  it('expires once the timeout elapses without CLI presence (no longer sticks)', () => {
    const now = dispatchedAt + UNSTARTED_TRAILING_USER_TURN_TIMEOUT_MS + 1;
    expect(isUnstartedTrailingDispatchPreStart([userTurnAt('2026-07-23T00:00:00.000Z')], now)).toBe(
      false
    );
  });

  it('never shows pre-start for a turn without a usable timestamp', () => {
    expect(isUnstartedTrailingDispatchPreStart([userTurn('pending')], dispatchedAt)).toBe(false);
  });
});
