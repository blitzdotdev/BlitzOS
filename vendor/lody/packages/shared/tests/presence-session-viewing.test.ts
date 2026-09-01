import { describe, expect, it } from 'vitest';

import {
  LODY_PRESENCE_TTL_MS,
  collectViewedSessionIdsFromPresence,
  getLodySessionViewingPresenceKey,
  parseLodyPresenceStates,
  type LodyPresenceInstanceId,
  type LodySessionViewingPresenceState,
} from '../src/presence';
import type { SessionId } from '../src/index';

const userId = 'user-1';
const instanceId = 'instance-1' as LodyPresenceInstanceId;
const sessionId = 'session-1' as SessionId;

const viewingState = (overrides: Partial<LodySessionViewingPresenceState> = {}) =>
  ({
    kind: 'session-viewing',
    userId,
    instanceId,
    sessionId,
    since: 1_000,
    updatedAt: 2_000,
    ...overrides,
  }) satisfies LodySessionViewingPresenceState;

describe('session-viewing presence', () => {
  it('round-trips through parseLodyPresenceStates keyed by (userId, instanceId)', () => {
    const key = getLodySessionViewingPresenceKey(userId, instanceId);
    expect(key).toBe('viewing:user-1:instance-1');

    const parsed = parseLodyPresenceStates({ [key]: viewingState() });
    expect(parsed[key]).toEqual(viewingState());
  });

  it('encodes special characters in key segments', () => {
    const key = getLodySessionViewingPresenceKey('user/1@x', 'in stance' as LodyPresenceInstanceId);
    expect(key).toBe('viewing:user%2F1%40x:in%20stance');
  });

  it('drops malformed viewing entries without affecting valid ones', () => {
    const key = getLodySessionViewingPresenceKey(userId, instanceId);
    const parsed = parseLodyPresenceStates({
      [key]: viewingState(),
      'viewing:bad': { kind: 'session-viewing', userId: '', instanceId, sessionId },
      'viewing:stale-shape': { kind: 'session-viewing' },
    });
    expect(Object.keys(parsed)).toEqual([key]);
  });

  it('collectViewedSessionIdsFromPresence returns only fresh viewing entries', () => {
    const nowMs = 100_000;
    const states = parseLodyPresenceStates({
      // fresh
      [getLodySessionViewingPresenceKey(userId, instanceId)]: viewingState({
        updatedAt: nowMs - 1_000,
      }),
      // stale (older than TTL)
      'viewing:user-2:instance-9': viewingState({
        userId: 'user-2',
        sessionId: 'session-2' as SessionId,
        updatedAt: nowMs - LODY_PRESENCE_TTL_MS - 1,
      }),
      // other kinds never count as viewers
      'session:session-3:instance-1': {
        kind: 'session',
        sessionId: 'session-3',
        machineId: 'machine-1',
        instanceId,
        status: { type: 'running' },
        updatedAt: nowMs - 1_000,
      },
    });

    const viewed = collectViewedSessionIdsFromPresence(states, nowMs);
    expect([...viewed]).toEqual([sessionId]);
  });
});
