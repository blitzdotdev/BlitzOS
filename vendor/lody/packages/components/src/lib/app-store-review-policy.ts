export const APP_STORE_REVIEW_MIN_EFFECTIVE_TURNS = 51;
export const APP_STORE_REVIEW_MIN_ACTIVE_DAYS = 2;
export const APP_STORE_REVIEW_ACTIVE_DAY_WINDOW = 3;
export const APP_STORE_REVIEW_NEGATIVE_CONTEXT_MS = 72 * 60 * 60 * 1000;
export const APP_STORE_REVIEW_ATTEMPT_COOLDOWN_MS = 90 * 24 * 60 * 60 * 1000;

const MAX_DEDUPLICATION_IDS = 512;

export type AppStoreReviewTurnOutcome = {
  id: string;
  kind: 'completed' | 'hard_failure';
  occurredAtMs: number;
};

export type AppStoreReviewPromptState = {
  schemaVersion: 1;
  /** Capped because eligibility only distinguishes 50 turns from 51 or more. */
  effectiveTurnCount: number;
  /** Recent local-calendar dates on which a valid completed turn occurred. */
  activeDayKeys: string[];
  /** Opaque turn identifiers used to make repeated history hydration idempotent. */
  recordedOutcomeIds: string[];
  lastHardFailureAtMs: number | null;
  lastRequestAttemptAtMs: number | null;
  lastRequestedVersion: string | null;
};

export function createAppStoreReviewPromptState(): AppStoreReviewPromptState {
  return {
    schemaVersion: 1,
    effectiveTurnCount: 0,
    activeDayKeys: [],
    recordedOutcomeIds: [],
    lastHardFailureAtMs: null,
    lastRequestAttemptAtMs: null,
    lastRequestedVersion: null,
  };
}

export function getLocalCalendarDayKey(timestampMs: number): string | null {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return null;
  const date = new Date(timestampMs);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function getRecentLocalCalendarDayKeys(nowMs: number): Set<string> {
  const keys = new Set<string>();
  if (!Number.isFinite(nowMs) || nowMs <= 0) return keys;
  const now = new Date(nowMs);
  for (let offset = 0; offset < APP_STORE_REVIEW_ACTIVE_DAY_WINDOW; offset += 1) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
    const key = getLocalCalendarDayKey(date.getTime());
    if (key) keys.add(key);
  }
  return keys;
}

export function recordAppStoreReviewTurnOutcomes(
  state: AppStoreReviewPromptState,
  outcomes: readonly AppStoreReviewTurnOutcome[]
): AppStoreReviewPromptState {
  const recordedOutcomeIds = new Set(state.recordedOutcomeIds);
  const activeDayKeys = new Set(state.activeDayKeys);
  let effectiveTurnCount = state.effectiveTurnCount;
  let lastHardFailureAtMs = state.lastHardFailureAtMs;
  let changed = false;

  for (const outcome of outcomes) {
    if (!outcome.id || recordedOutcomeIds.has(outcome.id)) continue;
    recordedOutcomeIds.add(outcome.id);
    changed = true;

    if (outcome.kind === 'hard_failure') {
      if (
        Number.isFinite(outcome.occurredAtMs) &&
        outcome.occurredAtMs > 0 &&
        (lastHardFailureAtMs == null || outcome.occurredAtMs > lastHardFailureAtMs)
      ) {
        lastHardFailureAtMs = outcome.occurredAtMs;
      }
      continue;
    }

    effectiveTurnCount = Math.min(APP_STORE_REVIEW_MIN_EFFECTIVE_TURNS, effectiveTurnCount + 1);
    const dayKey = getLocalCalendarDayKey(outcome.occurredAtMs);
    if (dayKey) activeDayKeys.add(dayKey);
  }

  if (!changed) return state;

  const nextRecordedOutcomeIds = Array.from(recordedOutcomeIds);
  // Once the user has cleared the only count threshold, dropping older ids cannot make a
  // repeated history scan alter eligibility. It keeps the device-local record bounded.
  const boundedOutcomeIds =
    effectiveTurnCount >= APP_STORE_REVIEW_MIN_EFFECTIVE_TURNS &&
    nextRecordedOutcomeIds.length > MAX_DEDUPLICATION_IDS
      ? nextRecordedOutcomeIds.slice(-MAX_DEDUPLICATION_IDS)
      : nextRecordedOutcomeIds;

  return {
    ...state,
    effectiveTurnCount,
    activeDayKeys: Array.from(activeDayKeys).sort().slice(-APP_STORE_REVIEW_ACTIVE_DAY_WINDOW),
    recordedOutcomeIds: boundedOutcomeIds,
    lastHardFailureAtMs,
  };
}

export function hasAppStoreReviewEligibility({
  state,
  appVersion,
  nowMs,
}: {
  state: AppStoreReviewPromptState;
  appVersion: string | null | undefined;
  nowMs: number;
}): boolean {
  const normalizedVersion = appVersion?.trim();
  if (!normalizedVersion || !Number.isFinite(nowMs) || nowMs <= 0) return false;
  if (state.effectiveTurnCount < APP_STORE_REVIEW_MIN_EFFECTIVE_TURNS) return false;

  const recentDayKeys = getRecentLocalCalendarDayKeys(nowMs);
  const activeDays = state.activeDayKeys.filter((dayKey) => recentDayKeys.has(dayKey));
  if (new Set(activeDays).size < APP_STORE_REVIEW_MIN_ACTIVE_DAYS) return false;

  if (
    state.lastHardFailureAtMs != null &&
    nowMs - state.lastHardFailureAtMs < APP_STORE_REVIEW_NEGATIVE_CONTEXT_MS
  ) {
    return false;
  }
  if (state.lastRequestedVersion === normalizedVersion) return false;
  if (
    state.lastRequestAttemptAtMs != null &&
    nowMs - state.lastRequestAttemptAtMs < APP_STORE_REVIEW_ATTEMPT_COOLDOWN_MS
  ) {
    return false;
  }
  return true;
}

export function markAppStoreReviewRequestAttempt(
  state: AppStoreReviewPromptState,
  { appVersion, attemptedAtMs }: { appVersion: string; attemptedAtMs: number }
): AppStoreReviewPromptState {
  return {
    ...state,
    lastRequestedVersion: appVersion,
    lastRequestAttemptAtMs: attemptedAtMs,
  };
}
