import type {
  SessionMeta,
  SessionPullRequestMeta,
  SessionPullRequestStateMeta,
} from '@lody/shared';
import {
  getSessionPullRequestLegacyFields,
  parseGitHubPullRequestUrl,
  resolveProjectGitHubRepo,
} from '@lody/shared';

export type SessionGitHubState = {
  repoFullName: string;
  latestPr: SessionPullRequestMeta | null;
  latestPrState: SessionPullRequestStateMeta | null;
  canShowGitHubActions: boolean;
  hasExistingPr: boolean;
  workspaceDirty: boolean;
  /**
   * Whether the session has any changes to base a PR on — uncommitted
   * (`workspaceDirty`) OR already committed (`diffStats.allChange > 0`). These
   * two signals come from independent writers (post-turn `git status` vs the
   * Code Collab file-index scanner), so together they survive one being stale
   * and, unlike `workspaceDirty` alone, keep "Create PR" available after the
   * agent auto-commits (clean tree, real commits, still no PR).
   */
  hasChanges: boolean;
};

export const getLatestPullRequest = (
  session: Pick<SessionMeta, 'pullRequests'> | null | undefined
): SessionPullRequestMeta | null => {
  const prList = session?.pullRequests ?? [];
  if (!prList.length) {
    return null;
  }
  if (!prList.some((pr) => getSessionPullRequestLegacyFields(pr).reportedAt)) {
    return prList[prList.length - 1] ?? null;
  }
  return prList.toSorted((a, b) => comparePullRequestRecency(a, b))[0] ?? null;
};

const comparePullRequestRecency = (
  left: SessionPullRequestMeta,
  right: SessionPullRequestMeta
): number => {
  const leftReportedAt = getSessionPullRequestLegacyFields(left).reportedAt ?? '';
  const rightReportedAt = getSessionPullRequestLegacyFields(right).reportedAt ?? '';
  if (leftReportedAt || rightReportedAt) {
    return rightReportedAt.localeCompare(leftReportedAt);
  }
  return 0;
};

export const getPullRequestNumber = (
  pr: SessionPullRequestMeta | null | undefined
): number | null =>
  typeof getSessionPullRequestLegacyFields(pr).number === 'number' &&
  Number.isFinite(getSessionPullRequestLegacyFields(pr).number)
    ? (getSessionPullRequestLegacyFields(pr).number ?? null)
    : pr?.url
      ? (parseGitHubPullRequestUrl(pr.url)?.prNumber ?? null)
      : null;

export const getPullRequestRepoFullName = (
  pr: SessionPullRequestMeta | null | undefined
): string | null =>
  getSessionPullRequestLegacyFields(pr).repository?.trim() ||
  (pr?.url ? (parseGitHubPullRequestUrl(pr.url)?.repoFullName ?? null) : null);

export const resolveWorkspaceOwnerSession = (
  session: SessionMeta | null | undefined,
  workspaceSession?: SessionMeta | null
): SessionMeta | null => workspaceSession ?? session ?? null;

/**
 * The GitHub identity and PR state a Session surface renders from.
 *
 * `gitHubIntegrationAvailable` is the `githubIntegration` platform capability,
 * and it defaults to `true` so every existing caller keeps today's behaviour.
 * Pass the capability where the answer decides what the user SEES: a local clone
 * carries a GitHub remote whether or not the app can reach the GitHub App, and
 * without this the repo name alone turns on "Create PR", the PR panel, the PR
 * badge and the `@issue`/`@pr` mention categories on a platform that has no
 * token to serve any of them.
 */
export const getSessionGitHubState = (
  session: SessionMeta | null | undefined,
  workspaceSession?: SessionMeta | null,
  gitHubIntegrationAvailable = true
): SessionGitHubState => {
  const sourceSession = resolveWorkspaceOwnerSession(session, workspaceSession);
  const repoFullName = !gitHubIntegrationAvailable
    ? ''
    : ((resolveProjectGitHubRepo(sourceSession?.project) ?? sourceSession?.repoFullName)?.trim() ??
      '');
  // Null with the capability off, not merely unused: `latestPr` is what the diff
  // panel turns into a PR number, and a review-comment fetch keyed on a number
  // with no repo is a request that can only fail.
  const latestPr = gitHubIntegrationAvailable ? getLatestPullRequest(sourceSession) : null;
  const latestPrState = latestPr?.url
    ? (sourceSession?.pullRequestState?.[latestPr.url] ?? null)
    : null;

  const workspaceDirty = sourceSession?.workspaceDirty ?? false;
  const allChange = sourceSession?.diffStats?.allChange;
  const hasCommittedDiff = allChange ? allChange.add + allChange.del > 0 : false;

  return {
    repoFullName,
    latestPr,
    latestPrState,
    canShowGitHubActions: !!repoFullName,
    hasExistingPr: !!repoFullName && !!latestPr,
    workspaceDirty,
    hasChanges: workspaceDirty || hasCommittedDiff,
  };
};
