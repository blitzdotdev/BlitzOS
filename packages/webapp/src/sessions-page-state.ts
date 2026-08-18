export type SettingsSection = 'profile' | 'members' | 'invites' | 'integrations' | 'requests';

export type DriveScope = 'mine' | 'shared';

export type AppRoute =
  | { workspaceId: string; page: 'webApp' }
  | { workspaceId: null; page: 'drive' }
  | { workspaceId: null; page: 'folder'; folderId: string; folderPath: string[] }
  | { workspaceId: null; page: 'templates' }
  | { workspaceId: null; page: 'template-new' }
  | { workspaceId: null; page: 'template-edit'; templateId: string }
  | { workspaceId: null; page: 'settings'; settingsSection: SettingsSection };

const HOME: AppRoute = { workspaceId: null, page: 'drive' };

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
  if (/^\/templates\/new\/?$/u.test(pathname)) {
    return { workspaceId: null, page: 'template-new' };
  }
  if (/^\/templates\/?$/u.test(pathname)) {
    return { workspaceId: null, page: 'templates' };
  }
  const templateEdit = pathname.match(/^\/templates\/([^/]+)\/edit\/?$/u);
  if (templateEdit) {
    try {
      return {
        workspaceId: null,
        page: 'template-edit',
        templateId: decodeURIComponent(templateEdit[1]!),
      };
    } catch {
      return HOME;
    }
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

/** Drive is one destination: the root lists owned folders and the folders
 * shared with the viewer. The old /shared address resolves here. */
export function drivePath(): string {
  return '/';
}

export function templateNewPath(): string {
  return '/templates/new';
}

export function templatesPath(): string {
  return '/templates';
}

export function templateEditPath(templateId: string): string {
  return `/templates/${encodeURIComponent(templateId)}/edit`;
}

export function folderPagePath(folderId: string, folderPath: string[] = []): string {
  const suffix = folderPath.map(encodeURIComponent).join('/');
  return `/folder/${encodeURIComponent(folderId)}${suffix === '' ? '' : `/${suffix}`}`;
}
