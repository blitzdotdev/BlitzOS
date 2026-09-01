import { execFile } from 'child_process';
import { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';
import type { CloudGithubTokenManager } from '@lody/platform';
import { createHash } from 'crypto';

export const LODY_MANAGED_GH_TOKEN_SHA256_ENV = 'LODY_MANAGED_GH_TOKEN_SHA256';

export const getGhTokenFingerprint = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

const isManagedGhTokenValue = (token: string | undefined, marker: string | undefined): boolean => {
  if (!token || !marker) {
    return false;
  }
  return getGhTokenFingerprint(token) === marker;
};

export const hasManagedGhToken = (env: Record<string, string | undefined>): boolean => {
  const marker = env[LODY_MANAGED_GH_TOKEN_SHA256_ENV];
  return (
    isManagedGhTokenValue(env.GH_TOKEN, marker) || isManagedGhTokenValue(env.GITHUB_TOKEN, marker)
  );
};

export const hasUserProvidedGhToken = (env: Record<string, string | undefined>): boolean => {
  const marker = env[LODY_MANAGED_GH_TOKEN_SHA256_ENV];
  const tokens = [env.GH_TOKEN, env.GITHUB_TOKEN].filter(
    (token): token is string => typeof token === 'string' && token.length > 0
  );
  return tokens.some((token) => !isManagedGhTokenValue(token, marker));
};

export const clearManagedGhTokenEnv = (env: Record<string, string | undefined>): void => {
  const marker = env[LODY_MANAGED_GH_TOKEN_SHA256_ENV];
  if (!marker) {
    return;
  }
  let cleared = false;
  if (isManagedGhTokenValue(env.GH_TOKEN, marker)) {
    delete env.GH_TOKEN;
    cleared = true;
  }
  if (isManagedGhTokenValue(env.GITHUB_TOKEN, marker)) {
    delete env.GITHUB_TOKEN;
    cleared = true;
  }
  if (cleared) {
    delete env[LODY_MANAGED_GH_TOKEN_SHA256_ENV];
  }
};

/**
 * Preserve an explicit GH_TOKEN/GITHUB_TOKEN. For managed repo sessions,
 * resolve a requester-bound write token before considering ambient `gh` auth
 * so a shared machine cannot leak its owner's GitHub identity into a turn.
 *
 * Returns the token string to inject, or null if no injection is needed.
 */
export async function resolveGhTokenForSession(options: {
  env: Record<string, string>;
  githubRepo: string | undefined;
  tokenManager: CloudGithubTokenManager | null;
  requesterUserId: string;
  machineId: string;
  logger: Logger;
}): Promise<string | null> {
  const { env, githubRepo, tokenManager, requesterUserId, machineId, logger } = options;

  // 1. Already has a user env token — no injection needed.
  // Lody-managed tokens are marked separately so resumed sessions can refresh them.
  if (hasUserProvidedGhToken(env)) {
    clearManagedGhTokenEnv(env);
    logger.debug('[gh-token] user-provided GH_TOKEN or GITHUB_TOKEN already set in env');
    return null;
  }

  if (githubRepo && tokenManager) {
    try {
      const managedRepoToken = await tokenManager.getWriteTokenInfoForRepo(githubRepo, {
        requesterUserId,
        machineId,
      });
      if (managedRepoToken.tokenSource === 'personal') {
        logger.debug(`[gh-token] Fetched personal operation token for ${githubRepo}`);
      }
      return managedRepoToken.token;
    } catch (error) {
      logger.debug(
        `[gh-token] Failed to fetch managed token for ${githubRepo}: ${formatErrorMessage(error)}`
      );
      clearManagedGhTokenEnv(env);
      return null;
    }
  }

  // 3. Without a managed repo-token path, check local `gh` CLI authentication.
  // Managed workspace repo tokens win above so ambient host auth cannot leak the machine owner's
  // GitHub identity into another requester's turn.
  if (await isGhCliAuthed(logger)) {
    clearManagedGhTokenEnv(env);
    logger.debug('[gh-token] Local gh CLI is authenticated');
    return null;
  }

  if (!githubRepo) {
    clearManagedGhTokenEnv(env);
    logger.debug('[gh-token] No GitHub repo context — cannot fetch managed token');
    return null;
  }

  if (!tokenManager) {
    clearManagedGhTokenEnv(env);
    logger.debug('[gh-token] No token manager available — cannot fetch managed token');
    return null;
  }
  return null;
}

/**
 * Check if the real `gh` CLI has valid authentication by running `gh auth status`.
 */
async function isGhCliAuthed(logger: Logger): Promise<boolean> {
  return new Promise((resolve) => {
    const child = execFile(
      'gh',
      ['auth', 'status'],
      { timeout: 5000, windowsHide: true },
      (error) => {
        if (error) {
          logger.debug(`[gh-token] gh auth status check failed: ${formatErrorMessage(error)}`);
          resolve(false);
        } else {
          resolve(true);
        }
      }
    );
    // Suppress stdio — we only care about exit code
    child.stdout?.resume();
    child.stderr?.resume();
  });
}
