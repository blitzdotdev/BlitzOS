import { describe, expect, it } from 'vitest';
import {
  consumeElectronBootstrapCredentials,
  ELECTRON_SESSION_TOKEN_ENV,
  ELECTRON_SESSION_USER_ID_ENV,
  withoutElectronBootstrapCredentials,
} from './electron-bootstrap-env';

describe('Electron bootstrap credentials', () => {
  it('consumes credentials and removes them from the CLI process environment', () => {
    const env = {
      [ELECTRON_SESSION_TOKEN_ENV]: ' session-token ',
      [ELECTRON_SESSION_USER_ID_ENV]: ' user-id ',
      PATH: '/bin',
    };

    expect(consumeElectronBootstrapCredentials(env)).toEqual({
      sessionToken: 'session-token',
      sessionUserId: 'user-id',
    });
    expect(env).toEqual({ PATH: '/bin' });
  });

  it('strips credentials from a child copy without mutating the source environment', () => {
    const env = {
      [ELECTRON_SESSION_TOKEN_ENV]: 'session-token',
      [ELECTRON_SESSION_USER_ID_ENV]: 'user-id',
      PATH: '/bin',
    };

    expect(withoutElectronBootstrapCredentials(env)).toEqual({ PATH: '/bin' });
    expect(env[ELECTRON_SESSION_TOKEN_ENV]).toBe('session-token');
  });
});
