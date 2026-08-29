import { describe, expect, it } from 'vitest';
import {
  getLegacyReadForSessionHistoryStatus,
  isSessionHistoryDelivered,
  isSessionHistoryPendingForDispatch,
} from '../src/schema';

describe('pending_apply session history status', () => {
  const entry = { role: 'user' as const, status: 'pending_apply' as const, read: false };

  it('is not delivered while waiting for steer acknowledgement', () => {
    expect(isSessionHistoryDelivered(entry)).toBe(false);
    expect(getLegacyReadForSessionHistoryStatus('pending_apply')).toBe(false);
  });

  it('is not eligible for ordinary queued dispatch', () => {
    expect(isSessionHistoryPendingForDispatch(entry)).toBe(false);
  });
});
