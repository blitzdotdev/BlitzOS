import { describe, expect, it } from 'vitest';
import {
  hasAuthenticatedUser,
  shouldConfirmUnauthenticated,
  shouldRefetchSessionOnBrowserResume,
  shouldRetryMissingAuthenticatedSession,
  shouldStartAuthenticatedSessionGrace,
  shouldUsePreservedAuthenticatedSession,
} from '../src/hooks/stable-session-state';

describe('stable-session-state', () => {
  it('detects authenticated users from session-like data', () => {
    expect(hasAuthenticatedUser({ user: { id: 'user-1' } })).toBe(true);
    expect(hasAuthenticatedUser({})).toBe(false);
    expect(hasAuthenticatedUser(null)).toBe(false);
  });

  it('starts an initial grace window from a bootstrapped session snapshot', () => {
    expect(
      shouldStartAuthenticatedSessionGrace({
        hasLocalToken: true,
        hasRawUser: false,
        hasLastAuthenticatedUser: false,
        previousHadRawUser: false,
        hasBootstrapSnapshot: true,
        hasConsumedInitialBootstrapGrace: false,
        isPending: false,
        shouldRetry: false,
        hasFinalError: false,
        preserveUntilMs: null,
      })
    ).toBe(true);
  });

  it('starts a grace window when an authenticated session briefly drops out', () => {
    expect(
      shouldStartAuthenticatedSessionGrace({
        hasLocalToken: true,
        hasRawUser: false,
        hasLastAuthenticatedUser: true,
        previousHadRawUser: true,
        hasBootstrapSnapshot: true,
        hasConsumedInitialBootstrapGrace: true,
        isPending: false,
        shouldRetry: false,
        hasFinalError: false,
        preserveUntilMs: null,
      })
    ).toBe(true);
  });

  it('does not start a new grace window after the initial bootstrap grace is consumed', () => {
    expect(
      shouldStartAuthenticatedSessionGrace({
        hasLocalToken: true,
        hasRawUser: false,
        hasLastAuthenticatedUser: false,
        previousHadRawUser: false,
        hasBootstrapSnapshot: true,
        hasConsumedInitialBootstrapGrace: true,
        isPending: false,
        shouldRetry: false,
        hasFinalError: false,
        preserveUntilMs: null,
      })
    ).toBe(false);
  });

  it('preserves the last authenticated session only while the grace window is active', () => {
    expect(
      shouldUsePreservedAuthenticatedSession({
        hasLocalToken: true,
        hasRawUser: false,
        hasLastAuthenticatedUser: true,
        preserveUntilMs: 2_000,
        now: 1_999,
      })
    ).toBe(true);

    expect(
      shouldUsePreservedAuthenticatedSession({
        hasLocalToken: true,
        hasRawUser: false,
        hasLastAuthenticatedUser: true,
        preserveUntilMs: 2_000,
        now: 2_000,
      })
    ).toBe(false);
  });

  it('waits for grace expiry before confirming unauthenticated state', () => {
    expect(
      shouldConfirmUnauthenticated({
        hasLocalToken: true,
        hasRawUser: false,
        isPending: false,
        shouldRetry: false,
        hasFinalError: false,
        preserveUntilMs: 5_000,
        now: 4_999,
      })
    ).toBe(false);

    expect(
      shouldConfirmUnauthenticated({
        hasLocalToken: true,
        hasRawUser: false,
        isPending: false,
        shouldRetry: false,
        hasFinalError: false,
        preserveUntilMs: 5_000,
        now: 5_000,
      })
    ).toBe(true);
  });

  it('retries a missing session while a local token says the user was previously signed in', () => {
    expect(
      shouldRetryMissingAuthenticatedSession({
        hasLocalToken: true,
        hasRawUser: false,
        isPending: false,
        hasError: false,
        retryCount: 0,
        maxRetries: 2,
      })
    ).toBe(true);

    expect(
      shouldRetryMissingAuthenticatedSession({
        hasLocalToken: true,
        hasRawUser: false,
        isPending: false,
        hasError: false,
        retryCount: 2,
        maxRetries: 2,
      })
    ).toBe(false);
  });

  it('does not retry missing session states that are not transient auth-hydration candidates', () => {
    const base = {
      hasLocalToken: true,
      hasRawUser: false,
      isPending: false,
      hasError: false,
      retryCount: 0,
      maxRetries: 2,
    };

    expect(shouldRetryMissingAuthenticatedSession({ ...base, hasLocalToken: false })).toBe(false);
    expect(shouldRetryMissingAuthenticatedSession({ ...base, hasRawUser: true })).toBe(false);
    expect(shouldRetryMissingAuthenticatedSession({ ...base, isPending: true })).toBe(false);
    expect(shouldRetryMissingAuthenticatedSession({ ...base, hasError: true })).toBe(false);
  });

  it('allows browser resume refetch when visible, online, idle, and outside throttle', () => {
    expect(
      shouldRefetchSessionOnBrowserResume({
        now: 30_000,
        lastRefetchAtMs: null,
        throttleMs: 30_000,
        isDocumentVisible: true,
        isBrowserOnline: true,
        isPending: false,
      })
    ).toBe(true);

    expect(
      shouldRefetchSessionOnBrowserResume({
        now: 61_000,
        lastRefetchAtMs: 30_000,
        throttleMs: 30_000,
        isDocumentVisible: true,
        isBrowserOnline: true,
        isPending: false,
      })
    ).toBe(true);
  });

  it('skips browser resume refetch while hidden, offline, pending, or throttled', () => {
    const base = {
      now: 40_000,
      lastRefetchAtMs: 30_000,
      throttleMs: 30_000,
      isDocumentVisible: true,
      isBrowserOnline: true,
      isPending: false,
    };

    expect(shouldRefetchSessionOnBrowserResume(base)).toBe(false);
    expect(
      shouldRefetchSessionOnBrowserResume({
        ...base,
        lastRefetchAtMs: null,
        isDocumentVisible: false,
      })
    ).toBe(false);
    expect(
      shouldRefetchSessionOnBrowserResume({
        ...base,
        lastRefetchAtMs: null,
        isBrowserOnline: false,
      })
    ).toBe(false);
    expect(
      shouldRefetchSessionOnBrowserResume({
        ...base,
        lastRefetchAtMs: null,
        isPending: true,
      })
    ).toBe(false);
  });
});
