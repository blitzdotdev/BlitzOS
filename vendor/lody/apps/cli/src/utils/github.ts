import { parseGitHubRepo, RepoId } from '@lody/shared';

export const normalizeGitHubRepo = (repo: string): string => {
  const { owner, repo: repoName } = parseGitHubRepo(repo);
  return `${owner}/${repoName}`;
};

/**
 * Derives a stable repo id from a GitHub repo reference.
 *
 * Accepted formats:
 * - `owner/repo`
 * - `https://github.com/owner/repo` (optional `.git`)
 * - `git@github.com:owner/repo` (optional `.git`)
 *
 * The derived id is intended for local caching paths (e.g. bare repo and worktrees). It is
 * readable and maps 1:1 to the source repository.
 */
export const deriveRepoIdFromGitHubRepo = (repo: string): RepoId => {
  const { owner, repo: repoName } = parseGitHubRepo(repo);
  return `github---${owner.toLowerCase()}---${repoName.toLowerCase()}` as RepoId;
};

export const buildGitHubCloneUrl = (repo: string): string =>
  `https://github.com/${normalizeGitHubRepo(repo)}.git`;

export const redactUrlAuth = (raw: string): string => {
  try {
    const url = new URL(raw);
    if (url.username) url.username = '***';
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    return raw;
  }
};
