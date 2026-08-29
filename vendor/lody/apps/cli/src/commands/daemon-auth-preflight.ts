import chalk from 'chalk';
import {
  type AuthClient,
  type AuthInfo,
  type UserInfo,
  type ValidateTokenResult,
  isTokenValidationUnavailable,
  performLogin,
} from '@/lib/auth';
import type { Logger } from '@/utils/logger';

/**
 * `lody daemon start` verifies backend reachability and credentials BEFORE it
 * spawns the detached daemon runner. Authentication that fails inside the
 * daemon happens in a background process nobody is watching, so the
 * interactive device-authorization flow has to run here, in the terminal the
 * user is actually looking at.
 */
export type DaemonAuthPreflightPlan =
  | { action: 'proceed'; user: UserInfo }
  | { action: 'login'; reason: 'missing_credentials' | 'credentials_rejected' }
  | { action: 'abort'; reason: 'backend_unreachable'; message: string }
  | { action: 'abort'; reason: 'login_required_non_interactive'; message: string };

/**
 * Pure decision: what should `daemon start` do given the cached credential, the
 * backend's verdict on it, and whether a human is watching this terminal?
 * `validation` is null when there is nothing to validate.
 */
export function planDaemonAuthPreflight(input: {
  existingAuth: AuthInfo | null;
  validation: ValidateTokenResult | null;
  /** False for CI/scripted runs: device authorization would block for minutes. */
  interactive: boolean;
}): DaemonAuthPreflightPlan {
  const { existingAuth, validation, interactive } = input;

  const login = (
    reason: 'missing_credentials' | 'credentials_rejected'
  ): DaemonAuthPreflightPlan =>
    interactive
      ? { action: 'login', reason }
      : {
          action: 'abort',
          reason: 'login_required_non_interactive',
          message:
            reason === 'credentials_rejected'
              ? 'This machine is no longer signed in to Lody.'
              : 'This machine is not connected to Lody yet.',
        };

  if (!existingAuth || !validation) {
    return login('missing_credentials');
  }

  if (validation.valid) {
    return { action: 'proceed', user: validation.user };
  }

  // Only an explicit `invalid` verdict means "this machine is signed out".
  // A network failure or an undecidable response is not a rejection: starting
  // device authorization there would replace a working credential on the
  // strength of an outage, so stop and let the operator retry instead.
  if (isTokenValidationUnavailable(validation)) {
    return {
      action: 'abort',
      reason: 'backend_unreachable',
      message: validation.error ?? validation.reason,
    };
  }

  return login('credentials_rejected');
}

export type DaemonAuthPreflightOutcome =
  | { status: 'authenticated'; user: UserInfo }
  | {
      status: 'failed';
      reason: 'backend_unreachable' | 'login_required_non_interactive' | 'login_failed';
      message: string;
    };

/**
 * Runs the plan: validates the cached credential against the backend and, when
 * this machine is not signed in, prints/opens the device-authorization link and
 * waits for the user to finish before the caller enters daemon mode.
 */
export async function ensureDaemonBackendAuth(options: {
  authClient: AuthClient;
  logger: Logger;
  machineName?: string | undefined;
  /** Defaults to "a terminal is attached"; device authorization needs a human. */
  interactive?: boolean;
}): Promise<DaemonAuthPreflightOutcome> {
  const { authClient, logger, machineName } = options;
  const interactive = options.interactive ?? process.stdout.isTTY === true;

  const existingAuth = authClient.getAuthInfo();
  logger.info('Checking the connection to Lody…');
  const validation = existingAuth ? await authClient.validateToken(existingAuth.token) : null;
  const plan = planDaemonAuthPreflight({ existingAuth, validation, interactive });

  if (plan.action === 'abort') {
    return {
      status: 'failed',
      reason: plan.reason,
      message:
        plan.reason === 'backend_unreachable'
          ? `Could not reach Lody to verify this machine's credentials: ${plan.message}`
          : plan.message,
    };
  }

  if (plan.action === 'proceed') {
    logger.success(
      `${chalk.green('✓')} Connected as ${chalk.cyan(plan.user.name || plan.user.email)}`
    );
    return { status: 'authenticated', user: plan.user };
  }

  logger.info(
    plan.reason === 'credentials_rejected'
      ? 'This machine is no longer signed in to Lody. Sign in again to connect it.'
      : 'This machine is not connected to Lody yet. Sign in to connect it.'
  );

  const loginResult = await performLogin(authClient, logger, { machineName });
  if (!loginResult.success) {
    return {
      status: 'failed',
      reason: 'login_failed',
      message: `Login failed: ${loginResult.error}`,
    };
  }

  logger.success(
    `${chalk.green('✓')} Connected as ${chalk.cyan(loginResult.user.name || loginResult.user.email)}`
  );
  return { status: 'authenticated', user: loginResult.user };
}
