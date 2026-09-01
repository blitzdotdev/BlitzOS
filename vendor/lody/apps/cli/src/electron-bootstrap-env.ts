export const ELECTRON_BOOTSTRAP_ENV = 'LODY_ELECTRON_BOOTSTRAP';
export const ELECTRON_SESSION_TOKEN_ENV = 'LODY_ELECTRON_SESSION_TOKEN';
export const ELECTRON_SESSION_USER_ID_ENV = 'LODY_ELECTRON_SESSION_USER_ID';

const ELECTRON_CREDENTIAL_ENV = [ELECTRON_SESSION_TOKEN_ENV, ELECTRON_SESSION_USER_ID_ENV] as const;

export function consumeElectronBootstrapCredentials(env: NodeJS.ProcessEnv): {
  sessionToken: string | undefined;
  sessionUserId: string | undefined;
} {
  const sessionToken = env[ELECTRON_SESSION_TOKEN_ENV]?.trim();
  const sessionUserId = env[ELECTRON_SESSION_USER_ID_ENV]?.trim();
  for (const key of ELECTRON_CREDENTIAL_ENV) {
    delete env[key];
  }
  return { sessionToken, sessionUserId };
}

export function withoutElectronBootstrapCredentials(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const childEnv = { ...env };
  for (const key of ELECTRON_CREDENTIAL_ENV) {
    delete childEnv[key];
  }
  return childEnv;
}
