export type SettingsSection = 'profile' | 'integrations' | 'requests';

export type AppRoute =
  | { workspaceId: string | null; page: 'cockpit' }
  | { workspaceId: null; page: 'settings'; settingsSection: SettingsSection };

export function parseAppRoute(pathname: string): AppRoute {
  const settings = pathname.match(/^\/settings(?:\/(profile|integrations|requests))?\/?$/u);
  if (settings) {
    return {
      workspaceId: null,
      page: 'settings',
      settingsSection: (settings[1] as SettingsSection | undefined) ?? 'profile',
    };
  }
  const match = pathname.match(/^\/workspaces\/([^/]+)\/?$/u);
  if (!match) return { workspaceId: null, page: 'cockpit' };
  try {
    return {
      workspaceId: decodeURIComponent(match[1]!),
      page: 'cockpit',
    };
  } catch {
    return { workspaceId: null, page: 'cockpit' };
  }
}

export function workspacePath(workspaceId: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}`;
}

export function settingsPath(section: SettingsSection): string {
  return section === 'profile' ? '/settings' : `/settings/${section}`;
}
