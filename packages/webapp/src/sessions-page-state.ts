export type SettingsSection = 'profile' | 'members' | 'invites' | 'integrations' | 'requests';

export type DriveScope = 'mine' | 'shared';

export type AppRoute =
  | { workspaceId: string; page: 'webApp' }
  | { workspaceId: null; page: 'drive'; scope: DriveScope }
  | { workspaceId: null; page: 'folder'; folderId: string; folderPath: string[] }
  | { workspaceId: null; page: 'template-new' }
  | { workspaceId: null; page: 'settings'; settingsSection: SettingsSection }
  | { workspaceId: null; page: 'invite'; inviteCode: string };

const HOME: AppRoute = { workspaceId: null, page: 'drive', scope: 'mine' };

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
  if (/^\/shared\/?$/u.test(pathname)) {
    return { workspaceId: null, page: 'drive', scope: 'shared' };
  }
  if (/^\/templates\/new\/?$/u.test(pathname)) {
    return { workspaceId: null, page: 'template-new' };
  }
  const invite = pathname.match(/^\/invite\/([A-Za-z0-9_-]{43})\/?$/u);
  if (invite) {
    // SAFETY: The regular expression admits only the 43-character invite code alphabet.
    return { workspaceId: null, page: 'invite', inviteCode: invite[1] as string };
  }
  const folder = pathname.match(/^\/folder\/([^/]+)((?:\/[^/]+)*)\/?$/u);
  if (folder) {
    try {
      return {
        workspaceId: null,
        page: 'folder',
        folderId: decodeURIComponent(folder[1]!),
        folderPath: (folder[2] ?? '')
          .split('/')
          .filter((segment) => segment.length > 0)
          .map(decodeURIComponent),
      };
    } catch {
      return HOME;
    }
  }
  const match = pathname.match(/^\/workspaces\/([^/]+)\/?$/u);
  if (!match) return HOME;
  try {
    return {
      workspaceId: decodeURIComponent(match[1]!),
      page: 'webApp',
    };
  } catch {
    return HOME;
  }
}

export function workspacePath(workspaceId: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}`;
}

export function settingsPath(section: SettingsSection): string {
  return section === 'profile' ? '/settings' : `/settings/${section}`;
}

export function drivePath(scope: DriveScope): string {
  return scope === 'shared' ? '/shared' : '/';
}

export function templateNewPath(): string {
  return '/templates/new';
}

export function folderPagePath(folderId: string, folderPath: string[] = []): string {
  const suffix = folderPath.map(encodeURIComponent).join('/');
  return `/folder/${encodeURIComponent(folderId)}${suffix === '' ? '' : `/${suffix}`}`;
}
