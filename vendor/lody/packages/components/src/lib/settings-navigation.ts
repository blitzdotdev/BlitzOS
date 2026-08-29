export type SettingsBackDestination = 'settings-list' | 'chat';

type GetSettingsBackDestinationOptions = {
  isMobile: boolean;
  settingsListPage: boolean;
};

export function getSettingsBackDestination({
  isMobile,
  settingsListPage,
}: GetSettingsBackDestinationOptions): SettingsBackDestination {
  if (isMobile && !settingsListPage) {
    return 'settings-list';
  }

  return 'chat';
}

/** Whether `pathname` is anywhere inside the workspace's settings section. */
export function isSettingsPath(pathname: string, workspaceName: string): boolean {
  const base = `/${workspaceName}/settings`;
  return pathname === base || pathname === `${base}/` || pathname.startsWith(`${base}/`);
}

/**
 * Where ⌘, / Esc should land when CLOSING settings: the path settings was opened from
 * (carried in the `from` search param so it survives tab navigation), or `null` to mean
 * "fall back to the chat landing". Rejects non-app and protocol-relative paths.
 */
export function resolveSettingsCloseTo(from: string | undefined): string | null {
  if (from && from.startsWith('/') && !from.startsWith('//')) {
    return from;
  }
  return null;
}
