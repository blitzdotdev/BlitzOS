import type { MessageQueueItem, SessionHistory } from './schema';

export const BILLING_PLAN_TIERS = ['free', 'plus', 'enterprise'] as const;
export type BillingPlanTier = (typeof BILLING_PLAN_TIERS)[number];
export type PaidBillingPlanTier = Exclude<BillingPlanTier, 'free'>;

export const FREE_WORKSPACE_LIMIT = 2;
export const FREE_WORKSPACE_MEMBER_LIMIT = 3;
export const FREE_SESSION_LIMIT_PER_WORKSPACE = 200;
export const FREE_SESSION_TURN_LIMIT = 30;
export const FREE_SESSION_TURN_WARNING_REMAINING = 5;

export type SessionQuotaKind = 'session_create' | 'session_turn';

export type BillingQuotaEntitlement = {
  effectivePlanTier: BillingPlanTier | null | undefined;
  checkoutPending?: boolean;
};

export type BillingQuotaAdmission =
  | { allowed: true }
  | {
      allowed: false;
      reason: 'checkout_pending' | 'limit_reached';
      current: number;
      limit: number;
    };

export type BillingQuotaRejection = Extract<BillingQuotaAdmission, { allowed: false }>;

export function formatSessionQuotaRejection(
  kind: SessionQuotaKind,
  rejection: BillingQuotaRejection
): string {
  if (rejection.reason === 'checkout_pending') {
    return kind === 'session_create'
      ? 'Complete checkout before creating sessions in this workspace.'
      : 'Complete checkout before sending messages in this workspace.';
  }
  return kind === 'session_create'
    ? `Free workspaces can create up to ${rejection.limit} sessions (currently ${rejection.current}).`
    : `Free sessions can accept up to ${rejection.limit} user turns (currently ${rejection.current}).`;
}

/**
 * A paid workspace with no pending checkout can never be blocked, so a caller
 * that has to pay for the current count (a Flock scan, a cache read) may skip
 * it. Same rule `evaluateBillingQuota` applies, so the two cannot drift.
 */
export function isBillingQuotaExempt(entitlement: BillingQuotaEntitlement): boolean {
  return !entitlement.checkoutPending && entitlement.effectivePlanTier !== 'free';
}

export function evaluateBillingQuota(
  args: BillingQuotaEntitlement & { current: number; limit: number }
): BillingQuotaAdmission {
  if (isBillingQuotaExempt(args)) {
    return { allowed: true };
  }

  if (args.checkoutPending) {
    return {
      allowed: false,
      reason: 'checkout_pending',
      current: args.current,
      limit: args.limit,
    };
  }

  if (args.current < args.limit) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: 'limit_reached',
    current: args.current,
    limit: args.limit,
  };
}

/**
 * Session-create admission derived from the local Flock session index.
 * `sessionCount` is `null` while that index has not hydrated: the count-based
 * limit then fails open, but a pending checkout still blocks because deciding
 * it needs no count.
 */
export function evaluateSessionCreateQuota(
  args: BillingQuotaEntitlement & { sessionCount: number | null }
): BillingQuotaAdmission {
  return evaluateBillingQuota({
    effectivePlanTier: args.effectivePlanTier,
    checkoutPending: args.checkoutPending,
    current: args.sessionCount ?? 0,
    limit: FREE_SESSION_LIMIT_PER_WORKSPACE,
  });
}

export function countSessionUserTurns(history: readonly Pick<SessionHistory, 'role'>[]): number {
  return history.reduce((count, entry) => count + (entry.role === 'user' ? 1 : 0), 0);
}

export function countPendingQueuedUserTurns(
  queue: readonly Pick<MessageQueueItem, 'task'>[] | null | undefined
): number {
  return queue?.length ?? 0;
}

export function countBillableSessionTurns(args: {
  history: readonly Pick<SessionHistory, 'role'>[];
  queue?: readonly Pick<MessageQueueItem, 'task'>[] | null;
}): number {
  return countSessionUserTurns(args.history) + countPendingQueuedUserTurns(args.queue);
}
