import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REVIEW_POLICY,
  type AgentConfigId,
  type ReviewRun,
  type ReviewRunId,
  type ReviewRunState,
  type SessionId,
} from '@lody/shared';
import {
  resolveApprovedShaPatch,
  resolveReviewerSessionSelection,
} from './review-automation-engine';

/**
 * Every branch of this rule is a bug that shipped. The two obvious conditions
 * each break a different real flow, so it is worth pinning all of them.
 */

const run = (overrides: Partial<ReviewRun> = {}): ReviewRun => ({
  id: 'run-1' as ReviewRunId,
  sessionId: 'session-1' as SessionId,
  policy: DEFAULT_REVIEW_POLICY,
  state: 'reviewing' as ReviewRunState,
  round: 1,
  ciFixUsed: 0,
  conflictUsed: 0,
  findings: [],
  events: [],
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
});

/** The reviewer just approved, in the state where that submission is unconsumed. */
const freshlyApproved = (overrides: Partial<ReviewRun> = {}): ReviewRun =>
  run({ state: 'reviewing', submittedRound: 1, round: 1, verdict: 'approve', ...overrides });

describe('resolveApprovedShaPatch', () => {
  it('pins the head a fresh approval judged', () => {
    expect(resolveApprovedShaPatch(freshlyApproved(), 'aaa')).toEqual({ approvedSha: 'aaa' });
  });

  it('re-pins on a later fresh approval, so the check cannot go stale', () => {
    // Stamping only when unset left the sha frozen at the first approval. The
    // post-approval check then compared old-vs-new forever: spot check ->
    // approve -> still unequal -> spot check, a loop with no budget brake.
    expect(resolveApprovedShaPatch(freshlyApproved({ approvedSha: 'aaa' }), 'bbb')).toEqual({
      approvedSha: 'bbb',
    });
  });

  it('arms the check in the approve-then-open-PR order', () => {
    // The approval lands before a PR exists, so there is no head to record then.
    expect(resolveApprovedShaPatch(freshlyApproved(), undefined)).toEqual({});
    // Once the PR exists the state has left `reviewing` for good. Requiring a
    // fresh approval here would leave `approvedSha` unset for the whole run and
    // any later push would merge unreviewed.
    const afterPrOpened = run({ state: 'creating_pr', verdict: 'approve', submittedRound: 1 });
    expect(resolveApprovedShaPatch(afterPrOpened, 'aaa')).toEqual({ approvedSha: 'aaa' });
  });

  it('does not re-pin from a stale approval once a sha is recorded', () => {
    // This is the half that must NOT fire outside a fresh approval: after a CI
    // fix pushes a new head, pinning it here would retire the check for a commit
    // the reviewer never saw.
    const staleApproval = run({
      state: 'fixing_ci',
      verdict: 'approve',
      submittedRound: 1,
      approvedSha: 'aaa',
    });
    expect(resolveApprovedShaPatch(staleApproval, 'bbb')).toEqual({});
  });

  it('never pins when the reviewer asked for changes', () => {
    const requested = run({ state: 'reviewing', submittedRound: 1, verdict: 'request_changes' });
    expect(resolveApprovedShaPatch(requested, 'aaa')).toEqual({});
  });

  it('does nothing without a head', () => {
    expect(resolveApprovedShaPatch(freshlyApproved({ approvedSha: 'aaa' }), undefined)).toEqual({});
  });
});

describe('resolveReviewerSessionSelection', () => {
  it('launches a new reviewer with the exact machine config and ACP options', () => {
    expect(
      resolveReviewerSessionSelection({
        agentConfigId: 'reviewer-config' as AgentConfigId,
        agentType: 'codex',
        modeId: 'plan',
        modelId: 'gpt-5.4',
        configOptionValues: {
          reasoning_effort: 'high',
          'fast-mode': false,
        },
      })
    ).toEqual({
      reviewerAgentConfigId: 'reviewer-config',
      reviewerAgentType: 'codex',
      modeId: 'plan',
      modelId: 'gpt-5.4',
      configOptionValues: {
        reasoning_effort: 'high',
        'fast-mode': false,
      },
    });
  });
});
