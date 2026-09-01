import { EXIT_CODE_RETRYABLE_STARTUP } from '@/lib/machine-lifecycle';

export type RejectedCredentialCleanupResult = 'cleared' | 'not_current' | 'failed';

export type RejectedCredentialRecovery = {
  exitCode: number;
  reason: string;
};

export function resolveBootstrapLoginFailure(options: {
  electronManaged: boolean;
  authFailureExitCode: number;
}): RejectedCredentialRecovery {
  if (options.electronManaged) {
    return {
      exitCode: EXIT_CODE_RETRYABLE_STARTUP,
      reason: 'Electron bootstrap failed; request fresh supervisor preparation',
    };
  }

  return {
    exitCode: options.authFailureExitCode,
    reason: 'Electron bootstrap login failed',
  };
}

export function resolveRejectedCredentialRecovery(options: {
  cleanup: RejectedCredentialCleanupResult;
  electronManaged: boolean;
  authFailureExitCode: number;
}): RejectedCredentialRecovery {
  if (options.cleanup === 'not_current') {
    return {
      exitCode: EXIT_CODE_RETRYABLE_STARTUP,
      reason: 'CLI credential was rotated by another process',
    };
  }

  if (options.cleanup === 'failed') {
    return {
      exitCode: options.authFailureExitCode,
      reason: 'failed to clear rejected CLI credential',
    };
  }

  if (options.electronManaged) {
    return {
      exitCode: EXIT_CODE_RETRYABLE_STARTUP,
      reason: 'rejected CLI credential cleared; request fresh Electron bootstrap session',
    };
  }

  return {
    exitCode: options.authFailureExitCode,
    reason: 'CLI credential rejected; run `lody login`',
  };
}
