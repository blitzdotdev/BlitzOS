import { describe, expect, it } from 'vitest';

import {
  APP_STORE_REVIEW_ATTEMPT_COOLDOWN_MS,
  APP_STORE_REVIEW_NEGATIVE_CONTEXT_MS,
  createAppStoreReviewPromptState,
  hasAppStoreReviewEligibility,
  markAppStoreReviewRequestAttempt,
  recordAppStoreReviewTurnOutcomes,
} from '../src/lib/app-store-review-policy';

const nowMs = new Date(2026, 4, 10, 12, 0, 0).getTime();
const appVersion = '1.5.0';

function eligibleTurnOutcomes(): Array<{
  id: string;
  kind: 'completed';
  occurredAtMs: number;
}> {
  return Array.from({ length: 51 }, (_, index) => ({
    id: `turn-${index}`,
    kind: 'completed' as const,
    occurredAtMs: index % 2 === 0 ? nowMs : nowMs - 24 * 60 * 60 * 1000,
  }));
}

describe('app store review policy', () => {
  it('requires more than fifty distinct successful turns across two recent days', () => {
    let state = recordAppStoreReviewTurnOutcomes(
      createAppStoreReviewPromptState(),
      eligibleTurnOutcomes().slice(0, 50)
    );

    expect(hasAppStoreReviewEligibility({ state, appVersion, nowMs })).toBe(false);

    state = recordAppStoreReviewTurnOutcomes(state, eligibleTurnOutcomes().slice(50));
    expect(hasAppStoreReviewEligibility({ state, appVersion, nowMs })).toBe(true);

    const repeated = recordAppStoreReviewTurnOutcomes(state, eligibleTurnOutcomes());
    expect(repeated).toBe(state);
    expect(repeated.effectiveTurnCount).toBe(51);
  });

  it('suppresses requests for seventy-two hours after a hard failure', () => {
    let state = recordAppStoreReviewTurnOutcomes(
      createAppStoreReviewPromptState(),
      eligibleTurnOutcomes()
    );
    state = recordAppStoreReviewTurnOutcomes(state, [
      { id: 'failed-turn', kind: 'hard_failure', occurredAtMs: nowMs - 1 },
    ]);

    expect(hasAppStoreReviewEligibility({ state, appVersion, nowMs })).toBe(false);

    state = {
      ...state,
      lastHardFailureAtMs: nowMs - APP_STORE_REVIEW_NEGATIVE_CONTEXT_MS,
    };
    expect(hasAppStoreReviewEligibility({ state, appVersion, nowMs })).toBe(true);
  });

  it('blocks both the current app version and a request attempt within ninety days', () => {
    const eligible = recordAppStoreReviewTurnOutcomes(
      createAppStoreReviewPromptState(),
      eligibleTurnOutcomes()
    );
    const attempted = markAppStoreReviewRequestAttempt(eligible, {
      appVersion,
      attemptedAtMs: nowMs - APP_STORE_REVIEW_ATTEMPT_COOLDOWN_MS - 1,
    });

    expect(hasAppStoreReviewEligibility({ state: attempted, appVersion, nowMs })).toBe(false);
    expect(hasAppStoreReviewEligibility({ state: attempted, appVersion: '1.5.1', nowMs })).toBe(
      true
    );

    const recentAttempt = markAppStoreReviewRequestAttempt(eligible, {
      appVersion: '1.5.1',
      attemptedAtMs: nowMs - 1,
    });
    expect(hasAppStoreReviewEligibility({ state: recentAttempt, appVersion: '1.5.2', nowMs })).toBe(
      false
    );
  });
});
