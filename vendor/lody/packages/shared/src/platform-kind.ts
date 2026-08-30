/** Build/launch-time product assembly. Kept below @lody/platform so Node-only
 * state and IPC helpers can select an installation namespace without creating
 * a dependency cycle. */
export type PlatformKind = 'local' | 'cloud';

export const PLATFORM_ENV_VAR = 'LODY_PLATFORM';
export const PLATFORM_VITE_ENV_VAR = 'VITE_LODY_PLATFORM';
/** Durable namespaces shared by the CLI, Electron shell, and platform package. */
export const LOCAL_WORKSPACE_ID_PREFIX = 'lw_';
export const LOCAL_USER_ID_PREFIX = 'local:';

export function isLocalWorkspaceId(id: string): boolean {
  return id.startsWith(LOCAL_WORKSPACE_ID_PREFIX);
}

export function isLocalUserId(id: string): boolean {
  return id.startsWith(LOCAL_USER_ID_PREFIX);
}

export function resolvePlatformKind(raw: string | undefined | null): PlatformKind {
  const value = raw?.trim();
  if (!value) return 'local';
  if (value === 'local' || value === 'cloud') return value;
  throw new Error(
    `Unrecognized ${PLATFORM_ENV_VAR} value: ${JSON.stringify(raw)} (expected "local" or "cloud")`
  );
}
