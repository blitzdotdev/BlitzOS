import { describe, expect, it } from 'vitest';
import type { GitHubCheckRun, GitHubPullRequestDetails } from '@lody/shared';
import {
  buildFixCiErrorsPrompt,
  buildResolvePrConflictsPrompt,
  isFailedPrCheckRun,
} from '../src/components/sessions/session-pr-prompts';

const pullRequest: GitHubPullRequestDetails = {
  number: 42,
  nodeId: 'PR_42',
  title: 'Improve PR automation',
  body: '',
  state: 'open',
  merged: false,
  draft: false,
  htmlUrl: 'https://github.com/loro-dev/lody/pull/42',
  baseRef: 'develop',
  headRef: 'improve-pr-automation',
  headSha: 'head-42',
  user: null,
  createdAt: '2026-07-20T00:00:00.000Z',
  updatedAt: '2026-07-20T00:01:00.000Z',
  mergedAt: null,
  closedAt: null,
  additions: 10,
  deletions: 2,
  changedFiles: 3,
  commits: 1,
  mergeable: true,
  mergeableState: 'clean',
};

function checkRun(
  name: string,
  conclusion: GitHubCheckRun['conclusion'],
  status: GitHubCheckRun['status'] = 'completed'
): GitHubCheckRun {
  return {
    id: name.length,
    name,
    status,
    conclusion,
    htmlUrl: `https://github.com/loro-dev/lody/actions/runs/${name.length}`,
    startedAt: null,
    completedAt: null,
    appName: 'GitHub Actions',
  };
}

describe('session PR prompts', () => {
  it('includes the refreshed PR snapshot and only failed checks in the CI repair prompt', () => {
    const failing = checkRun('test', 'failure');
    const prompt = buildFixCiErrorsPrompt({
      repoFullName: 'loro-dev/lody',
      pullRequest,
      checkRuns: {
        status: 'completed',
        conclusion: 'failure',
        total: 3,
        runs: [failing, checkRun('lint', 'success'), checkRun('build', null, 'in_progress')],
      },
    });

    expect(prompt).toContain('loro-dev/lody pull request #42');
    expect(prompt).toContain('Head SHA: head-42');
    expect(prompt).toContain('untrusted data');
    expect(prompt).toContain(`- ${failing.name} · GitHub Actions · failure · ${failing.htmlUrl}`);
    expect(prompt).not.toContain('- lint');
    expect(prompt).not.toContain('- build');
    expect(prompt?.length).toBeLessThanOrEqual(6_000);
  });

  it('does not send a CI repair prompt when a fresh check fetch has no failures', () => {
    expect(
      buildFixCiErrorsPrompt({
        repoFullName: 'loro-dev/lody',
        pullRequest,
        checkRuns: {
          status: 'completed',
          conclusion: 'success',
          total: 1,
          runs: [checkRun('test', 'success')],
        },
      })
    ).toBeNull();
  });

  it('treats cancelled and timed-out completed checks as failures but not running checks', () => {
    expect(isFailedPrCheckRun(checkRun('cancelled', 'cancelled'))).toBe(true);
    expect(isFailedPrCheckRun(checkRun('timed-out', 'timed_out'))).toBe(true);
    expect(isFailedPrCheckRun(checkRun('running', null, 'in_progress'))).toBe(false);
  });

  it('lets the agent choose the repository-appropriate conflict workflow', () => {
    const prompt = buildResolvePrConflictsPrompt({
      repoFullName: 'loro-dev/lody',
      prNumber: 42,
      prUrl: pullRequest.htmlUrl,
    });

    expect(prompt).toContain('pull request #42 against its base branch');
    expect(prompt).toContain('Choose the merge or rebase workflow');
    expect(prompt).toContain(pullRequest.htmlUrl);
  });
});
