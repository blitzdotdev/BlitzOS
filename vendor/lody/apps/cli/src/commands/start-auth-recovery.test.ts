import { describe, expect, it } from 'vitest';
import { EXIT_CODE_AUTH_FAILURE, EXIT_CODE_RETRYABLE_STARTUP } from '@/lib/machine-lifecycle';
import {
  resolveBootstrapLoginFailure,
  resolveRejectedCredentialRecovery,
} from './start-auth-recovery';

describe('Electron bootstrap login recovery', () => {
  it('retries from a fresh supervisor preparation when the session snapshot is rejected', () => {
    expect(
      resolveBootstrapLoginFailure({
        electronManaged: true,
        authFailureExitCode: EXIT_CODE_AUTH_FAILURE,
      })
    ).toEqual({
      exitCode: EXIT_CODE_RETRYABLE_STARTUP,
      reason: 'Electron bootstrap failed; request fresh supervisor preparation',
    });
  });

  it('keeps non-Electron bootstrap failures fatal', () => {
    expect(
      resolveBootstrapLoginFailure({
        electronManaged: false,
        authFailureExitCode: 1,
      })
    ).toEqual({
      exitCode: 1,
      reason: 'Electron bootstrap login failed',
    });
  });
});

describe('rejected startup credential recovery', () => {
  it('starts a fresh supervisor generation for an Electron-managed worker', () => {
    expect(
      resolveRejectedCredentialRecovery({
        cleanup: 'cleared',
        electronManaged: true,
        authFailureExitCode: EXIT_CODE_AUTH_FAILURE,
      })
    ).toEqual({
      exitCode: EXIT_CODE_RETRYABLE_STARTUP,
      reason: 'rejected CLI credential cleared; request fresh Electron bootstrap session',
    });
  });

  it('retries when another process already rotated the credential', () => {
    expect(
      resolveRejectedCredentialRecovery({
        cleanup: 'not_current',
        electronManaged: true,
        authFailureExitCode: EXIT_CODE_AUTH_FAILURE,
      })
    ).toEqual({
      exitCode: EXIT_CODE_RETRYABLE_STARTUP,
      reason: 'CLI credential was rotated by another process',
    });
  });

  it('fails closed when the rejected credential cannot be removed', () => {
    expect(
      resolveRejectedCredentialRecovery({
        cleanup: 'failed',
        electronManaged: true,
        authFailureExitCode: EXIT_CODE_AUTH_FAILURE,
      })
    ).toEqual({
      exitCode: EXIT_CODE_AUTH_FAILURE,
      reason: 'failed to clear rejected CLI credential',
    });
  });

  it('requires an explicit login for a standalone worker', () => {
    expect(
      resolveRejectedCredentialRecovery({
        cleanup: 'cleared',
        electronManaged: false,
        authFailureExitCode: 1,
      })
    ).toEqual({
      exitCode: 1,
      reason: 'CLI credential rejected; run `lody login`',
    });
  });
});
