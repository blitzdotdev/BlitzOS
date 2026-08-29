import { describe, expect, it } from 'vitest';
import {
  countBillableSessionTurns,
  evaluateBillingQuota,
  evaluateSessionCreateQuota,
  formatSessionQuotaRejection,
  FREE_SESSION_LIMIT_PER_WORKSPACE,
  FREE_SESSION_TURN_LIMIT,
  isBillingQuotaExempt,
} from '../src/billing';
import { shouldBypassSessionQuota } from '../src/session-orchestration';

describe('evaluateBillingQuota', () => {
  it('blocks known free plans at the limit', () => {
    expect(
      evaluateBillingQuota({
        effectivePlanTier: 'free',
        current: FREE_SESSION_TURN_LIMIT,
        limit: FREE_SESSION_TURN_LIMIT,
      })
    ).toEqual({
      allowed: false,
      reason: 'limit_reached',
      current: FREE_SESSION_TURN_LIMIT,
      limit: FREE_SESSION_TURN_LIMIT,
    });
  });

  it('fails open when entitlement is unavailable', () => {
    expect(
      evaluateBillingQuota({
        effectivePlanTier: undefined,
        current: FREE_SESSION_TURN_LIMIT,
        limit: FREE_SESSION_TURN_LIMIT,
      })
    ).toEqual({ allowed: true });
  });

  it('allows paid plans above the free limit', () => {
    expect(
      evaluateBillingQuota({
        effectivePlanTier: 'plus',
        current: FREE_SESSION_TURN_LIMIT + 1,
        limit: FREE_SESSION_TURN_LIMIT,
      })
    ).toEqual({ allowed: true });
  });

  it('blocks checkout-pending workspaces before evaluating the plan', () => {
    expect(
      evaluateBillingQuota({
        effectivePlanTier: undefined,
        checkoutPending: true,
        current: 0,
        limit: FREE_SESSION_TURN_LIMIT,
      })
    ).toEqual({
      allowed: false,
      reason: 'checkout_pending',
      current: 0,
      limit: FREE_SESSION_TURN_LIMIT,
    });
  });
});

describe('formatSessionQuotaRejection', () => {
  it('keeps create and turn quota copy centralized', () => {
    expect(
      formatSessionQuotaRejection('session_create', {
        allowed: false,
        reason: 'limit_reached',
        current: 200,
        limit: 200,
      })
    ).toBe('Free workspaces can create up to 200 sessions (currently 200).');
    expect(
      formatSessionQuotaRejection('session_turn', {
        allowed: false,
        reason: 'checkout_pending',
        current: 0,
        limit: 30,
      })
    ).toBe('Complete checkout before sending messages in this workspace.');
  });
});

describe('shouldBypassSessionQuota', () => {
  it('bypasses quotas only for durable batch commands', () => {
    expect(shouldBypassSessionQuota('session_create_many')).toBe(true);
    expect(shouldBypassSessionQuota('session_chat_many')).toBe(true);
    expect(shouldBypassSessionQuota('session_create')).toBe(false);
    expect(shouldBypassSessionQuota('session_chat')).toBe(false);
  });
});

describe('evaluateSessionCreateQuota', () => {
  it('fails the count-based cap open while the session index has not hydrated', () => {
    expect(
      evaluateSessionCreateQuota({ effectivePlanTier: 'free', sessionCount: null })
    ).toEqual({ allowed: true });
  });

  it('still blocks a pending checkout without a count', () => {
    expect(
      evaluateSessionCreateQuota({
        effectivePlanTier: 'free',
        checkoutPending: true,
        sessionCount: null,
      })
    ).toEqual({
      allowed: false,
      reason: 'checkout_pending',
      current: 0,
      limit: FREE_SESSION_LIMIT_PER_WORKSPACE,
    });
  });

  it('blocks free workspaces at the session cap', () => {
    expect(
      evaluateSessionCreateQuota({
        effectivePlanTier: 'free',
        sessionCount: FREE_SESSION_LIMIT_PER_WORKSPACE,
      })
    ).toEqual({
      allowed: false,
      reason: 'limit_reached',
      current: FREE_SESSION_LIMIT_PER_WORKSPACE,
      limit: FREE_SESSION_LIMIT_PER_WORKSPACE,
    });
  });
});

describe('isBillingQuotaExempt', () => {
  it('exempts only paid workspaces with no pending checkout', () => {
    expect(isBillingQuotaExempt({ effectivePlanTier: 'plus' })).toBe(true);
    expect(isBillingQuotaExempt({ effectivePlanTier: 'plus', checkoutPending: true })).toBe(false);
    expect(isBillingQuotaExempt({ effectivePlanTier: 'free' })).toBe(false);
    // Unknown entitlement fails open, matching evaluateBillingQuota.
    expect(isBillingQuotaExempt({ effectivePlanTier: undefined })).toBe(true);
  });
});

describe('countBillableSessionTurns', () => {
  it('counts user history entries and queued prompts', () => {
    expect(
      countBillableSessionTurns({
        history: [{ role: 'user' }, { role: 'assistant' }, { role: 'user' }],
        queue: [{ task: 'queued one' }, { task: 'queued two' }],
      })
    ).toBe(4);
  });
});
