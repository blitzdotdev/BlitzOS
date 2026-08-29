import { describe, expect, it } from 'vitest';
import {
  formatSessionTabSearch,
  getSessionTabUrlSyncAction,
  parseSessionTabSearch,
} from '../src/lib/session-tab-url';

describe('parseSessionTabSearch', () => {
  it('returns missing when tab is absent', () => {
    expect(parseSessionTabSearch(undefined)).toEqual({ kind: 'missing' });
  });

  it('parses a child session tab', () => {
    expect(parseSessionTabSearch('session:child-session-id')).toEqual({
      kind: 'session',
      sessionId: 'child-session-id',
    });
  });

  it('treats empty and malformed values as invalid', () => {
    expect(parseSessionTabSearch('')).toEqual({ kind: 'invalid' });
    expect(parseSessionTabSearch('session:')).toEqual({ kind: 'invalid' });
    expect(parseSessionTabSearch('viewer:file:src/index.ts')).toEqual({ kind: 'invalid' });
  });
});

describe('formatSessionTabSearch', () => {
  it('omits the parent session tab from the URL', () => {
    expect(formatSessionTabSearch('parent-session-id', 'parent-session-id')).toBeUndefined();
  });

  it('formats a child session tab', () => {
    expect(formatSessionTabSearch('child-session-id', 'parent-session-id')).toBe(
      'session:child-session-id'
    );
  });
});

describe('getSessionTabUrlSyncAction', () => {
  it('activates the session encoded in the URL', () => {
    expect(
      getSessionTabUrlSyncAction({ kind: 'session', sessionId: 'child-session-id' })
    ).toEqual({
      kind: 'activate-session',
      sessionId: 'child-session-id',
    });
  });

  it('falls back to the parent for invalid and non-ignored missing URLs', () => {
    expect(getSessionTabUrlSyncAction({ kind: 'invalid' })).toEqual({ kind: 'activate-parent' });
    expect(getSessionTabUrlSyncAction({ kind: 'missing' })).toEqual({
      kind: 'activate-parent',
    });
  });

  it('ignores the next missing URL sync when the app cleared the URL for a draft tab', () => {
    expect(
      getSessionTabUrlSyncAction({ kind: 'missing' }, { ignoreMissing: true })
    ).toEqual({ kind: 'noop' });
  });
});
