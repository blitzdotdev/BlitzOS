import { describe, expect, it } from 'vitest';
import type { AuthInfo } from '@/lib/auth';
import { planDaemonAuthPreflight } from './daemon-auth-preflight';

const cachedAuth: AuthInfo = {
  token: 'cli_token',
  user: { id: 'user_1', name: 'Cached User', email: 'cached@example.com' },
  machine: { machineId: 'machine_1', machineName: 'build-host' },
};

describe('planDaemonAuthPreflight', () => {
  it('signs in when this machine has no credentials', () => {
    expect(
      planDaemonAuthPreflight({ existingAuth: null, validation: null, interactive: true })
    ).toEqual({ action: 'login', reason: 'missing_credentials' });
  });

  it('proceeds with the server-resolved user when the credential is accepted', () => {
    expect(
      planDaemonAuthPreflight({
        existingAuth: cachedAuth,
        interactive: true,
        validation: {
          valid: true,
          userId: 'user_1',
          user: { id: 'user_1', name: 'Server User', email: 'server@example.com' },
        },
      })
    ).toEqual({
      action: 'proceed',
      user: { id: 'user_1', name: 'Server User', email: 'server@example.com' },
    });
  });

  it('signs in again when the backend rejects the credential', () => {
    expect(
      planDaemonAuthPreflight({
        existingAuth: cachedAuth,
        interactive: true,
        validation: { valid: false, retryable: false, reason: 'invalid' },
      })
    ).toEqual({ action: 'login', reason: 'credentials_rejected' });
  });

  it('aborts instead of re-authenticating when the backend is unreachable', () => {
    expect(
      planDaemonAuthPreflight({
        existingAuth: cachedAuth,
        interactive: true,
        validation: {
          valid: false,
          retryable: true,
          reason: 'network_error',
          error: 'fetch failed',
        },
      })
    ).toEqual({ action: 'abort', reason: 'backend_unreachable', message: 'fetch failed' });
  });

  it('aborts on an undecidable validation response', () => {
    expect(
      planDaemonAuthPreflight({
        existingAuth: cachedAuth,
        interactive: true,
        validation: { valid: false, retryable: false, reason: 'invalid_response' },
      })
    ).toEqual({
      action: 'abort',
      reason: 'backend_unreachable',
      message: 'invalid_response',
    });
  });

  it('never waits on device authorization without a terminal', () => {
    // CI and scripted runs: blocking on a browser link nobody can open would
    // hang the command until the device code expires.
    expect(
      planDaemonAuthPreflight({ existingAuth: null, validation: null, interactive: false })
    ).toMatchObject({ action: 'abort', reason: 'login_required_non_interactive' });

    expect(
      planDaemonAuthPreflight({
        existingAuth: cachedAuth,
        interactive: false,
        validation: { valid: false, retryable: false, reason: 'invalid' },
      })
    ).toMatchObject({ action: 'abort', reason: 'login_required_non_interactive' });
  });

  it('still starts a valid daemon without a terminal', () => {
    expect(
      planDaemonAuthPreflight({
        existingAuth: cachedAuth,
        interactive: false,
        validation: { valid: true, userId: 'user_1', user: cachedAuth.user },
      })
    ).toEqual({ action: 'proceed', user: cachedAuth.user });
  });
});
