export type SettingsSection = 'profile' | 'members' | 'invites' | 'integrations' | 'requests';

export type AppRoute =
  | { workspaceId: string | null; page: 'webApp' }
  | { workspaceId: null; page: 'settings'; settingsSection: SettingsSection };

export function parseAppRoute(pathname: string): AppRoute {
  const settings = pathname.match(/^\/settings(?:\/(profile|members|invites|integrations|requests))?\/?$/u);
  if (settings) {
    return {
      workspaceId: null,
      page: 'settings',
      // SAFETY: The regular expression captures only the SettingsSection literals in group 1.
      settingsSection: (settings[1] as SettingsSection | undefined) ?? 'profile',
    };
  }
  const match = pathname.match(/^\/workspaces\/([^/]+)\/?$/u);
  if (!match) return { workspaceId: null, page: 'webApp' };
  try {
    return {
      workspaceId: decodeURIComponent(match[1]!),
      page: 'webApp',
    };
  } catch {
    return { workspaceId: null, page: 'webApp' };
  }
}

export function workspacePath(workspaceId: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}`;
}

export function settingsPath(section: SettingsSection): string {
  return section === 'profile' ? '/settings' : `/settings/${section}`;
}
