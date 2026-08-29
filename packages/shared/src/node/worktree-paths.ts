// Node-only entrypoint: re-exports the shared (browser-safe) helpers and overrides
// `deriveRepoIdFromLocalProjectPath` to use `node:crypto` instead of the pure-JS SHA-256
// fallback. CLI/Node consumers should import from here so the digest path skips the
// browser shim. Browser code imports directly from `@lody/shared`.
import { createHash } from 'node:crypto';

import type { RepoId } from '..';

export {
  parseGitHubRepo,
  deriveRepoIdFromGitHubRepo,
  getDefaultSessionWorkdirFromDotlodyPath,
  getLodyDotlodyPath,
  getLodyReposBaseDir,
  getLodyReposBaseDirFromDotlodyPath,
  getWorktreeHostPath,
  getWorktreeHostPathFromDotlodyPath,
  getWorktreeRelativePath,
  isLocalRepoId,
} from '../worktree-paths';
export type { RepoId, SessionId } from '..';

const LOCAL_REPO_ID_PREFIX = 'local---';

function normalizeLocalProjectPathForRepoId(p: string): string {
  const normalized = p.trim().replace(/\\/g, '/');
  if (normalized === '/' || /^[A-Za-z]:\/$/.test(normalized)) {
    return normalized;
  }
  return normalized.replace(/\/+$/g, '');
}

export function deriveRepoIdFromLocalProjectPath(absolutePath: string): RepoId {
  const normalized = normalizeLocalProjectPathForRepoId(absolutePath);
  if (!normalized) {
    throw new Error('Invalid local project path: empty value');
  }
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 12);
  return `${LOCAL_REPO_ID_PREFIX}${hash}` as RepoId;
}
