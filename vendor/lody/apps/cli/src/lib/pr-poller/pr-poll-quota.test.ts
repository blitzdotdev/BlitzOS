import { describe, expect, it } from 'vitest';
import { loadPrPollerConfig } from './pr-poller-config';
import {
  applyProviderSafetyFloor,
  computeRepoCooldownDelayMs,
  fullScopeQuota,
  isScopeFrozen,
  nextRepoCooldown,
  refillScopeQuota,
  scopeQuotaAvailableAtMs,
  spendScopeQuota,
} from './pr-poll-quota';

const config = loadPrPollerConfig({});
const T0 = 1_720_000_000_000;

describe('scope quota bucket', () => {
  it('starts full and clamps refill at capacity', () => {
    const quota = fullScopeQuota(T0, config);
    expect(quota.tokens).toBe(config.bucketCapacityPoints);
    const later = refillScopeQuota(quota, T0 + 60 * 60_000, config);
    expect(later.tokens).toBe(config.bucketCapacityPoints);
  });

  it('refills linearly by elapsed minutes', () => {
    const spent = spendScopeQuota(fullScopeQuota(T0, config), config.bucketCapacityPoints, config);
    expect(spent.tokens).toBe(0);
    const after = refillScopeQuota(spent, T0 + 2 * 60_000, config);
    expect(after.tokens).toBeCloseTo(2 * config.bucketRefillPointsPerMinute);
  });

  it('spend clamps at zero (actual cost only known post-hoc)', () => {
    const quota = spendScopeQuota({ tokens: 1, updatedAtMs: T0 }, 5, config);
    expect(quota.tokens).toBe(0);
  });

  it('reports the next available time from the deficit', () => {
    const empty = { tokens: 0.5, updatedAtMs: T0 };
    // 0.5 missing points at 4 pts/min → 7.5 s.
    expect(scopeQuotaAvailableAtMs(empty, T0, config)).toBe(T0 + 7_500);
    expect(scopeQuotaAvailableAtMs({ tokens: 2, updatedAtMs: T0 }, T0, config)).toBe(T0);
  });

  it('a freeze wins over available tokens', () => {
    const frozen = { tokens: 10, updatedAtMs: T0, frozenUntilMs: T0 + 60_000 };
    expect(isScopeFrozen(frozen, T0)).toBe(true);
    expect(isScopeFrozen(frozen, T0 + 60_000)).toBe(false);
    expect(scopeQuotaAvailableAtMs(frozen, T0, config)).toBe(T0 + 60_000);
  });

  it('provider safety floor freezes when remaining < 10% of limit', () => {
    const quota = fullScopeQuota(T0, config);
    const frozen = applyProviderSafetyFloor(
      quota,
      { remaining: 400, limit: 5000, resetAtMs: T0 + 3_600_000 },
      T0,
      config,
      600_000
    );
    expect(frozen.frozenUntilMs).toBe(T0 + 3_600_000);

    // Missing resetAt → the caller's default freeze window.
    const defaulted = applyProviderSafetyFloor(
      quota,
      { remaining: 400, limit: 5000, resetAtMs: null },
      T0,
      config,
      600_000
    );
    expect(defaulted.frozenUntilMs).toBe(T0 + 600_000);

    // Healthy remaining → untouched.
    const healthy = applyProviderSafetyFloor(
      quota,
      { remaining: 4000, limit: 5000, resetAtMs: T0 + 3_600_000 },
      T0,
      config,
      600_000
    );
    expect(healthy.frozenUntilMs).toBeUndefined();
  });
});

describe('repo cooldown', () => {
  it('backs off 15min → 30min → 60min → 120min and caps there', () => {
    expect(computeRepoCooldownDelayMs(1, config)).toBe(15 * 60_000);
    expect(computeRepoCooldownDelayMs(2, config)).toBe(30 * 60_000);
    expect(computeRepoCooldownDelayMs(3, config)).toBe(60 * 60_000);
    expect(computeRepoCooldownDelayMs(4, config)).toBe(120 * 60_000);
    expect(computeRepoCooldownDelayMs(9, config)).toBe(120 * 60_000);
  });

  it('accumulates consecutive failures and stamps the next retry time', () => {
    const first = nextRepoCooldown(undefined, 'repo-not-found-or-forbidden', T0, config);
    expect(first).toEqual({
      consecutiveFailures: 1,
      nextRetryAtMs: T0 + 15 * 60_000,
      lastErrorKind: 'repo-not-found-or-forbidden',
    });
    const second = nextRepoCooldown(first, 'token-invalid', T0 + 15 * 60_000, config);
    expect(second.consecutiveFailures).toBe(2);
    expect(second.nextRetryAtMs).toBe(T0 + 15 * 60_000 + 30 * 60_000);
  });
});
