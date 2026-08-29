import { shellEnv } from 'shell-env';

// Match the Electron probe's budget (cli-service.ts SHELL_ENV_TIMEOUT_MS).
const SHELL_ENV_TIMEOUT_MS = 3000;

/**
 * Resolving the login-shell env spawns the user's shell with `-ilc` so it sources
 * their full profile. That is slow (~100-300ms) but the result does not change
 * mid-session, so memoize the first resolution for the process lifetime.
 */
let cachedShellEnvPromise: Promise<NodeJS.ProcessEnv> | null = null;
/** Last successfully resolved env, exposed to synchronous callers. */
let resolvedShellEnv: NodeJS.ProcessEnv = {};

const shouldSkip = (): boolean =>
  // shell-env just returns process.env on win32, so skip the subprocess there.
  process.platform === 'win32' || process.env.LODY_DISABLE_SHELL_ENV === '1';

const resolveOnce = (): Promise<NodeJS.ProcessEnv> => {
  const probe = shellEnv()
    .then((env) => {
      resolvedShellEnv = env;
      // The race below may have already resolved the memoized promise to {} via
      // the timeout. Replace it so *later* awaiters (acp-runner aux sessions,
      // history-sync) get the real env instead of being stuck on the timeout's
      // empty overlay for the rest of the process — otherwise the sync accessor
      // (which reads resolvedShellEnv) and the async accessor would permanently
      // disagree after a slow-but-successful probe.
      cachedShellEnvPromise = Promise.resolve(env);
      return env;
    })
    .catch((): NodeJS.ProcessEnv => ({}));

  // shell-env has no built-in timeout; a hanging dotfile would otherwise block
  // every awaiting ACP spawn forever. Fail open to the empty overlay so the
  // withDefaultAcpPathEntries fallback still applies. We cannot reap the spawned
  // login shell here (shell-env exposes no child handle), but execa's default
  // cleanup kills it on process exit, so at worst a hung dotfile leaks one idle
  // shell for the daemon's lifetime — not per spawn.
  const timeout = new Promise<NodeJS.ProcessEnv>((resolve) => {
    const timer = setTimeout(() => resolve({}), SHELL_ENV_TIMEOUT_MS);
    timer.unref();
  });

  return Promise.race([probe, timeout]);
};

/**
 * Read the environment (most importantly `PATH`) from the user's login shell
 * profile via the `shell-env` library.
 *
 * GUI/daemon launches (Electron Dock, systemd, npx, IDE terminals) inherit a
 * minimal PATH that omits the dirs users actually install tools into
 * (`~/.local/bin`, homebrew, cargo, volta, asdf, ...). Spawning an agent binary
 * such as `opencode acp` then fails with `spawn opencode ENOENT`. `shell-env`
 * sources the login shell, so we pick up tools wherever they live instead of
 * guessing a fixed set of directories.
 *
 * Never throws: on a clean failure the `.catch` yields `{}` (an empty overlay).
 * Note `shell-env` itself, when every candidate shell fails, falls back to
 * returning the inherited `process.env` rather than throwing — so the overlay may
 * be the full process env, not `{}`. That stays safe because `mergeLoginShellEnv`
 * is base-wins for non-PATH vars (a no-op for vars the base already has) and the
 * caller scrubs inherited auth/routing vars *after* overlaying (see session.ts).
 * Disable entirely via `LODY_DISABLE_SHELL_ENV=1`.
 */
export const getLoginShellEnv = async (): Promise<NodeJS.ProcessEnv> => {
  if (shouldSkip()) {
    return {};
  }
  if (!cachedShellEnvPromise) {
    cachedShellEnvPromise = resolveOnce();
  }
  return cachedShellEnvPromise;
};

/**
 * Synchronous view of the login-shell env for callers that cannot await, such as
 * terminal-manager environment callbacks. Returns `{}` until
 * `getLoginShellEnv()` has resolved at least once, so the first read kicks off
 * resolution and relies on the `withDefaultAcpPathEntries` fallback for that one
 * call; later reads see the cached env. ACP startup awaits the async accessor.
 */
export const getCachedLoginShellEnvSync = (): NodeJS.ProcessEnv => {
  if (shouldSkip()) {
    return {};
  }
  if (!cachedShellEnvPromise) {
    void getLoginShellEnv();
  }
  return resolvedShellEnv;
};

/** Test-only: clear the memoized login-shell env so cases can re-resolve. */
export const resetLoginShellEnvCache = (): void => {
  cachedShellEnvPromise = null;
  resolvedShellEnv = {};
};
