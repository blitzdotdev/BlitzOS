import {
  GitHubMergeError,
  GitHubPermissionError,
  hashAnalyticsId,
  type GitHubCheckRunsSummary,
  type GitHubMergeMethod,
  type GitHubPullRequestDetails,
} from '@lody/shared';

import { capturePostHogEvent, type PostHogAnalyticsClient } from '@/lib/posthog-analytics';
import { isDraftPr } from '@/lib/github-pr-details-state';

// Diff / PR / Code Review analytics (spec §8d). The helpers below cover the
// merge funnel (`pr_tab/merge_*`) and the diff_comment funnel (thread_created /
// github_thread_created+_failed / sent_to_chat). They are split out of the
// components (which are pure/near-pure render units) following the
// mention-analytics.ts pattern so call sites stay thin and the property shaping
// + denylist-safe hashing live in one place.
//
// The `pr_tab/opened` and `diff_viewer/opened` events were removed as redundant
// with the already-shipped `session/pr_tab_opened` / `session/viewer_diff_opened`
// equivalents owned by session-detail.
//
// All events are tier B (one user action = one event) except the merge funnel,
// which is a core funnel triplet (tier A, full) per spec §8d. capturePostHogEvent
// already null-guards the client and sanitizes properties, so every helper is
// side-effect-only and never throws into product code.

/** Coarse PR lifecycle state for funnel breakdown (non-PII). */
export type PrAnalyticsStatus = 'open' | 'closed' | 'merged' | 'draft' | 'unknown';

/** Coarse CI rollup for funnel breakdown (non-PII). */
export type CiAnalyticsStatus = 'none' | 'pending' | 'success' | 'failure' | 'neutral' | 'unknown';

/** Normalized merge failure classification (spec §2.4 — enum, not free text). */
export type MergeErrorKind =
  | 'conflict'
  | 'checks_failed'
  | 'permission'
  | 'method_disabled'
  | 'not_mergeable'
  | 'auth'
  | 'unknown';

export type DiffCommentChatSource = 'lody' | 'github';

export function resolvePrAnalyticsStatus(
  pr: GitHubPullRequestDetails | null | undefined
): PrAnalyticsStatus {
  if (!pr) return 'unknown';
  if (pr.merged) return 'merged';
  if (pr.state === 'closed') return 'closed';
  if (isDraftPr(pr)) return 'draft';
  return 'open';
}

export function resolveCiAnalyticsStatus(
  summary: GitHubCheckRunsSummary | null | undefined
): CiAnalyticsStatus {
  if (!summary || summary.total === 0) return 'none';
  if (summary.status === 'in_progress' || summary.status === 'queued') return 'pending';
  switch (summary.conclusion) {
    case 'success':
      return 'success';
    case 'failure':
    case 'timed_out':
      return 'failure';
    case 'neutral':
    case 'cancelled':
    case 'action_required':
    case 'stale':
    case 'skipped':
      return 'neutral';
    default:
      return 'unknown';
  }
}

// Classify a merge failure into a stable enum. GitHub returns the human-facing
// reason only as a free-text message on a 405; we never forward that message
// (PII-risky + unbreakable for breakdowns, spec §2.3/§2.4) and instead derive a
// code from the error type + the PR's own mergeability hints we already have.
export function classifyMergeError(
  error: unknown,
  pr: GitHubPullRequestDetails | null | undefined
): MergeErrorKind {
  if (error instanceof GitHubPermissionError) return 'permission';
  if (error instanceof GitHubMergeError) {
    if (error.status === 401) return 'auth';
    if (error.status === 403) return 'permission';
    // 405 Method Not Allowed = not mergeable; 409 = conflict. Disambiguate
    // 405 further using the PR mergeability we already loaded.
    if (error.status === 409) return 'conflict';
    if (error.status === 405) {
      if (pr) {
        if (pr.mergeable === false || pr.mergeableState === 'dirty') return 'conflict';
        if (pr.mergeableState === 'blocked' || pr.mergeableState === 'unstable') {
          return 'checks_failed';
        }
        // 405 on an otherwise-clean PR is GitHub rejecting the merge method
        // itself (e.g. squash/rebase disabled on the repo).
        if (pr.mergeable === true || pr.mergeableState === 'clean') return 'method_disabled';
      }
      return 'not_mergeable';
    }
    return 'unknown';
  }
  const name = error instanceof Error ? error.name : '';
  if (name === 'GitHubAuthError') return 'auth';
  return 'unknown';
}

type PrTabBaseProps = {
  workspaceId?: string | null;
  sessionId?: string | null;
  repoFullName?: string | null;
  prNumber: number;
};

function withPrBase(props: Record<string, unknown>, base: PrTabBaseProps): Record<string, unknown> {
  return {
    workspace_id: base.workspaceId ?? null,
    session_id: base.sessionId ?? null,
    // Repo names can be private; send a non-PII surrogate only (spec §2.3).
    repo_id_hash: hashAnalyticsId(base.repoFullName ?? null),
    pr_number: base.prNumber,
    ...props,
  };
}

export function capturePrMergeRequested(
  postHog: PostHogAnalyticsClient | null | undefined,
  base: PrTabBaseProps,
  props: {
    mergeMethod: GitHubMergeMethod;
    prStatus: PrAnalyticsStatus;
    ciStatus: CiAnalyticsStatus;
  }
): void {
  capturePostHogEvent(
    postHog,
    'pr_tab/merge_requested',
    withPrBase(
      {
        merge_method: props.mergeMethod,
        pr_status: props.prStatus,
        ci_status: props.ciStatus,
      },
      base
    )
  );
}

export function capturePrMergeSucceeded(
  postHog: PostHogAnalyticsClient | null | undefined,
  base: PrTabBaseProps,
  props: { mergeMethod: GitHubMergeMethod; durationMs: number | null }
): void {
  capturePostHogEvent(
    postHog,
    'pr_tab/merge_succeeded',
    withPrBase(
      {
        merge_method: props.mergeMethod,
        duration_ms: props.durationMs,
      },
      base
    )
  );
}

export function capturePrMergeFailed(
  postHog: PostHogAnalyticsClient | null | undefined,
  base: PrTabBaseProps,
  props: { mergeMethod: GitHubMergeMethod; errorKind: MergeErrorKind; durationMs: number | null }
): void {
  capturePostHogEvent(
    postHog,
    'pr_tab/merge_failed',
    withPrBase(
      {
        merge_method: props.mergeMethod,
        error_kind: props.errorKind,
        duration_ms: props.durationMs,
      },
      base
    )
  );
}

type DiffCommentBaseProps = {
  workspaceId?: string | null;
  sessionId?: string | null;
  /** Diff context: conversation-mode (per turn) vs base-mode (all changes). */
  mode?: 'conversation' | 'base';
};

function withDiffCommentBase(
  props: Record<string, unknown>,
  base: DiffCommentBaseProps
): Record<string, unknown> {
  return {
    workspace_id: base.workspaceId ?? null,
    session_id: base.sessionId ?? null,
    mode: base.mode ?? 'conversation',
    ...props,
  };
}

export function captureDiffCommentThreadCreated(
  postHog: PostHogAnalyticsClient | null | undefined,
  base: DiffCommentBaseProps,
  props: { syncToGithub: boolean; prLinked: boolean; mentionCount: number }
): void {
  capturePostHogEvent(
    postHog,
    'diff_comment/thread_created',
    withDiffCommentBase(
      {
        sync_to_github: props.syncToGithub,
        pr_linked: props.prLinked,
        mention_count: props.mentionCount,
      },
      base
    )
  );
}

export function captureDiffCommentGithubThreadCreated(
  postHog: PostHogAnalyticsClient | null | undefined,
  base: DiffCommentBaseProps,
  props: { durationMs: number | null }
): void {
  capturePostHogEvent(
    postHog,
    'diff_comment/github_thread_created',
    withDiffCommentBase({ duration_ms: props.durationMs }, base)
  );
}

export function captureDiffCommentGithubThreadFailed(
  postHog: PostHogAnalyticsClient | null | undefined,
  base: DiffCommentBaseProps,
  props: { errorKind: MergeErrorKind; durationMs: number | null }
): void {
  capturePostHogEvent(
    postHog,
    'diff_comment/github_thread_create_failed',
    withDiffCommentBase(
      {
        error_kind: props.errorKind,
        duration_ms: props.durationMs,
      },
      base
    )
  );
}

export function captureDiffCommentSentToChat(
  postHog: PostHogAnalyticsClient | null | undefined,
  base: DiffCommentBaseProps,
  props: { source: DiffCommentChatSource; accepted: boolean; replyCount: number }
): void {
  capturePostHogEvent(
    postHog,
    'diff_comment/sent_to_chat',
    withDiffCommentBase(
      {
        source: props.source,
        accepted: props.accepted,
        reply_count: props.replyCount,
      },
      base
    )
  );
}

// Classify a GitHub review-comment-create failure (sync_to_github path). Reuses
// the merge-error taxonomy since both go through the same write-token + GitHub
// REST surface; PR mergeability hints don't apply here so we pass null.
export function classifyGithubThreadError(error: unknown): MergeErrorKind {
  return classifyMergeError(error, null);
}
