import type { Meta, StoryObj } from '@storybook/react';
import {
  DEFAULT_REVIEW_POLICY,
  type ReviewFinding,
  type ReviewRun,
  type ReviewRunId,
  type ReviewRunState,
  type SessionId,
} from '@lody/shared';
import { AutoReviewStatus } from '@/components/sessions/auto-review-status';

const finding = (overrides: Partial<ReviewFinding> = {}): ReviewFinding => ({
  id: 'r1-1',
  file: 'apps/cli/src/lib/pr-poller/pr-poll-select.ts',
  line: 88,
  severity: 'blocking',
  title: 'Dueness ignores the attempt floor after a failure',
  detail:
    'A failed poll updates lastAttempt but the comparison only reads lastSuccess, so a failing repo is retried on every pass.',
  failureScenario:
    'With a repo returning 5xx, the scheduler dispatches it every tick instead of honouring the 15 minute cooldown.',
  resolution: 'open',
  raisedInRound: 1,
  ...overrides,
});

const run = (state: ReviewRunState, overrides: Partial<ReviewRun> = {}): ReviewRun => ({
  id: 'run-1' as ReviewRunId,
  sessionId: 'session-1' as SessionId,
  policy: DEFAULT_REVIEW_POLICY,
  state,
  round: 1,
  ciFixUsed: 0,
  conflictUsed: 0,
  findings: [],
  events: [],
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
});

const meta = {
  title: 'Sessions/AutoReviewStatus',
  component: AutoReviewStatus,
  parameters: { layout: 'centered' },
  args: {
    maxRounds: DEFAULT_REVIEW_POLICY.budget.reviewRounds,
    onDisable: () => {},
    onFixFinding: () => {},
  },
  decorators: [
    (Story) => (
      <div className="w-[560px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AutoReviewStatus>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Reviewing: Story = {
  args: { run: run('reviewing') },
};

/** Findings are the working surface: each one is actionable on its own. */
export const ChangesRequested: Story = {
  args: {
    run: run('fixing', {
      round: 2,
      findings: [
        finding(),
        finding({
          id: 'r1-2',
          severity: 'suggestion',
          title: 'Name reads as a boolean',
          file: 'apps/cli/src/lib/pr-poller/pr-poll-quota.ts',
        }),
      ],
    }),
  },
};

export const WaitingForCi: Story = {
  args: { run: run('waiting_ci', { round: 2 }) },
};

/** The first automatic merge in a workspace always stops here. */
export const AwaitingConfirmation: Story = {
  args: { run: run('awaiting_merge_confirmation', { round: 2 }) },
};

export const Paused: Story = {
  args: { run: run('paused', { round: 1 }) },
};

/** Every terminal state carries a plain-language handoff, never a bare code. */
export const BlockedOnBudget: Story = {
  args: {
    run: run('blocked', {
      round: 4,
      findings: [finding()],
      blocked: {
        reason: 'budget_exhausted',
        summary:
          'The review budget of 4 rounds ran out with 1 blocking finding still open. The findings list has what is left.',
      },
    }),
  },
};

export const BlockedOnProtectedPath: Story = {
  args: {
    run: run('blocked', {
      blocked: {
        reason: 'protected_path',
        summary:
          'This branch changes protected paths (REVIEW.md), so it will not be merged automatically. Merge it yourself after checking those changes.',
      },
    }),
  },
};

export const Merged: Story = {
  args: { run: run('merged', { round: 2 }) },
};

/** A one-shot "Review this branch" that came back clean. */
export const ReviewOnlyClean: Story = {
  args: { run: run('reviewed', { mode: 'review_only' }) },
};

/** A one-shot review that found something. Nothing is driven; the user decides. */
export const ReviewOnlyWithFindings: Story = {
  args: {
    run: run('reviewed', { mode: 'review_only', findings: [finding()] }),
  },
};
