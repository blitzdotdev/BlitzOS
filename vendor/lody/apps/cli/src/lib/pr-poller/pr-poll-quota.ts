import type { PrPollerConfig } from './pr-poller-config';
import type { PrPollRepoCooldownState, PrPollScopeQuotaState } from './pr-poller-state';
import type { PrPollErrorKind } from './github-graphql-client';

/**
 * Quota state machine (spec `specs/pr-status-reconciler.md` — Quota 状态机).
 *
 * Pure transitions for the per-credential-scope token bucket, provider
 * freezes, and repo error cooldowns. This module is lane-blind: it only
 * answers "can scope X spend now — and if not, when". Fairness between
 * lanes lives in `pr-poll-select.ts`; timers live in the orchestrator.
 */

/** A fresh, full bucket for a scope we have never seen. */
export function fullScopeQuota(nowMs: number, config: PrPollerConfig): PrPollScopeQuotaState {
  return { tokens: config.bucketCapacityPoints, updatedAtMs: nowMs };
}

/** Apply time-based refill; clamps to capacity. Frozen state is preserved. */
export function refillScopeQuota(
  quota: PrPollScopeQuotaState,
  nowMs: number,
  config: PrPollerConfig
): PrPollScopeQuotaState {
  const elapsedMinutes = Math.max(0, nowMs - quota.updatedAtMs) / 60_000;
  const tokens = Math.min(
    config.bucketCapacityPoints,
    quota.tokens + elapsedMinutes * config.bucketRefillPointsPerMinute
  );
  return { ...quota, tokens, updatedAtMs: nowMs };
}

export function isScopeFrozen(quota: PrPollScopeQuotaState, nowMs: number): boolean {
  return quota.frozenUntilMs !== undefined && quota.frozenUntilMs > nowMs;
}

/**
 * When the scope can next spend one point. `quota` must already be refilled
 * to `nowMs`: the freeze end if frozen, `nowMs` if non-empty, otherwise the
 * refill time for one more point.
 */
export function scopeQuotaAvailableAtMs(
  quota: PrPollScopeQuotaState,
  nowMs: number,
  config: PrPollerConfig
): number {
  const frozenUntilMs = quota.frozenUntilMs;
  if (frozenUntilMs !== undefined && frozenUntilMs > nowMs) {
    return frozenUntilMs;
  }
  if (quota.tokens >= 1) {
    return nowMs;
  }
  const deficit = 1 - quota.tokens;
  return nowMs + Math.ceil((deficit / config.bucketRefillPointsPerMinute) * 60_000);
}

/** Spend points after a completed call; clamps at zero (cost is only known post-hoc). */
export function spendScopeQuota(
  quota: PrPollScopeQuotaState,
  points: number,
  config: PrPollerConfig
): PrPollScopeQuotaState {
  return {
    ...quota,
    tokens: Math.max(0, Math.min(config.bucketCapacityPoints, quota.tokens - points)),
  };
}

/**
 * Provider safety floor: freeze the scope until `resetAt` when GitHub reports
 * `remaining < ratio × limit`, regardless of local credit. Returns the input
 * unchanged when the floor is not hit.
 */
export function applyProviderSafetyFloor(
  quota: PrPollScopeQuotaState,
  rateLimit: { remaining: number; limit: number; resetAtMs: number | null },
  nowMs: number,
  config: PrPollerConfig,
  defaultFreezeMs: number
): PrPollScopeQuotaState {
  if (
    rateLimit.limit > 0 &&
    rateLimit.remaining < config.rateLimitFreezeRemainingRatio * rateLimit.limit
  ) {
    return { ...quota, frozenUntilMs: rateLimit.resetAtMs ?? nowMs + defaultFreezeMs };
  }
  return quota;
}

/**
 * Repo-level cooldown delay: 15 min first, doubling per consecutive failure,
 * capped at 2 h. Reset happens by deleting the cooldown entry on success.
 */
export function computeRepoCooldownDelayMs(
  consecutiveFailures: number,
  config: PrPollerConfig
): number {
  const exponent = Math.max(0, consecutiveFailures - 1);
  return Math.min(config.repoCooldownBaseMs * 2 ** exponent, config.repoCooldownMaxMs);
}

export function nextRepoCooldown(
  previous: PrPollRepoCooldownState | undefined,
  kind: Exclude<PrPollErrorKind, 'rate-limited' | 'network-error'>,
  nowMs: number,
  config: PrPollerConfig
): PrPollRepoCooldownState {
  const consecutiveFailures = (previous?.consecutiveFailures ?? 0) + 1;
  return {
    consecutiveFailures,
    nextRetryAtMs: nowMs + computeRepoCooldownDelayMs(consecutiveFailures, config),
    lastErrorKind: kind,
  };
}
