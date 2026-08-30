export const DEFAULT_AUTHENTICATED_SESSION_GRACE_MS = 2_000;
export const DEFAULT_SESSION_RESUME_REFETCH_THROTTLE_MS = 30_000;
export const DEFAULT_SESSION_KEEPALIVE_REFETCH_INTERVAL_MS = 5 * 60_000;

export type AuthSessionLike =
  | {
      user?: unknown;
    }
  | null
  | undefined;

type SessionGraceStartOptions = {
  hasLocalToken: boolean;
  hasRawUser: boolean;
  hasLastAuthenticatedUser: boolean;
  previousHadRawUser: boolean;
  hasBootstrapSnapshot: boolean;
  hasConsumedInitialBootstrapGrace: boolean;
  isPending: boolean;
  shouldRetry: boolean;
  hasFinalError: boolean;
  preserveUntilMs: number | null;
};

type PreserveSessionOptions = {
  hasLocalToken: boolean;
  hasRawUser: boolean;
  hasLastAuthenticatedUser: boolean;
  preserveUntilMs: number | null;
  now: number;
};

type ConfirmUnauthenticatedOptions = {
  hasLocalToken: boolean;
  hasRawUser: boolean;
  isPending: boolean;
  shouldRetry: boolean;
  hasFinalError: boolean;
  preserveUntilMs: number | null;
  now: number;
};

type BrowserResumeRefetchOptions = {
  now: number;
  lastRefetchAtMs: number | null;
  throttleMs: number;
  isDocumentVisible: boolean;
  isBrowserOnline: boolean;
  isPending: boolean;
};

type MissingAuthenticatedSessionRetryOptions = {
  hasLocalToken: boolean;
  hasRawUser: boolean;
  isPending: boolean;
  hasError: boolean;
  retryCount: number;
  maxRetries: number;
};

export function hasAuthenticatedUser(data: AuthSessionLike): boolean {
  return Boolean(data?.user);
}

export function shouldRetryMissingAuthenticatedSession(
  options: MissingAuthenticatedSessionRetryOptions,
): boolean {
  return (
    options.hasLocalToken &&
    !options.hasRawUser &&
    !options.isPending &&
    !options.hasError &&
    options.retryCount < options.maxRetries
  );
}

export function shouldStartAuthenticatedSessionGrace(options: SessionGraceStartOptions): boolean {
  if (
    !options.hasLocalToken ||
    options.hasRawUser ||
    options.isPending ||
    options.shouldRetry ||
    options.hasFinalError ||
    options.preserveUntilMs !== null
  ) {
    return false;
  }

  if (options.previousHadRawUser && options.hasLastAuthenticatedUser) {
    return true;
  }

  if (!options.hasConsumedInitialBootstrapGrace && options.hasBootstrapSnapshot) {
    return true;
  }

  return false;
}

export function shouldUsePreservedAuthenticatedSession(options: PreserveSessionOptions): boolean {
  return (
    options.hasLocalToken &&
    !options.hasRawUser &&
    options.hasLastAuthenticatedUser &&
    options.preserveUntilMs !== null &&
    options.now < options.preserveUntilMs
  );
}

export function shouldConfirmUnauthenticated(options: ConfirmUnauthenticatedOptions): boolean {
  return (
    options.hasLocalToken &&
    !options.hasRawUser &&
    !options.isPending &&
    !options.shouldRetry &&
    !options.hasFinalError &&
    (options.preserveUntilMs === null || options.now >= options.preserveUntilMs)
  );
}

export function shouldRefetchSessionOnBrowserResume(options: BrowserResumeRefetchOptions): boolean {
  if (!options.isDocumentVisible || !options.isBrowserOnline || options.isPending) {
    return false;
  }

  if (
    options.lastRefetchAtMs !== null &&
    options.now - options.lastRefetchAtMs < options.throttleMs
  ) {
    return false;
  }

  return true;
}
