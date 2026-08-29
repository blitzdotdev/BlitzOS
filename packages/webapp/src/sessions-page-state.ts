export type SettingsSection =
  | 'profile'
  | 'members'
  | 'invites'
  | 'connections'
  | 'compute'
  | 'requests'
  | 'usage';

export type DriveScope = 'mine' | 'shared';

export type AppRoute =
  | { workspaceId: string; page: 'webApp' }
  | { workspaceId: null; page: 'drive' }
  | { workspaceId: null; page: 'folder'; folderId: string; folderPath: string[] }
  | { workspaceId: null; page: 'settings'; settingsSection: SettingsSection };

const HOME: AppRoute = { workspaceId: null, page: 'drive' };

export function parseAppRoute(pathname: string): AppRoute {
  const settings = pathname.match(/^\/settings(?:\/(profile|members|invites|connections|integrations|compute|requests|usage))?\/?$/u);
  if (settings) {
    // '/settings/integrations' is the pre-rename address; old bookmarks
    // canonicalize to the connections section.
    const section = settings[1] === 'integrations' ? 'connections' : settings[1];
    return {
      workspaceId: null,
      page: 'settings',
      // SAFETY: After the fold, group 1 holds only SettingsSection literals.
      settingsSection: (section as SettingsSection | undefined) ?? 'profile',
    };
  }
  // Templates and recipes are disabled product-wide (2026-08-29): their
  // control-plane routes are unmounted, so these addresses fall through to
  // Drive rather than open a page whose every request 404s. The page code
  // stays in the tree; restore these branches to bring the surfaces back.
  // if (/^\/templates\/new\/?$/u.test(pathname)) {
  //   return { workspaceId: null, page: 'template-new' };
  // }
  // if (/^\/templates\/?$/u.test(pathname)) {
  //   return { workspaceId: null, page: 'templates' };
  // }
  // const templateEdit = pathname.match(/^\/templates\/([^/]+)\/edit\/?$/u);
  // if (templateEdit) { ... page: 'template-edit' ... }
  // if (/^\/recipes\/new\/?$/u.test(pathname)) {
  //   return { workspaceId: null, page: 'recipe-new' };
  // }
  // if (/^\/recipes\/?$/u.test(pathname)) {
  //   return { workspaceId: null, page: 'recipes' };
  // }
  // const recipeEdit = pathname.match(/^\/recipes\/([^/]+)\/edit\/?$/u);
  // if (recipeEdit) { ... page: 'recipe-edit' ... }
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

export function folderPagePath(folderId: string, folderPath: string[] = []): string {
  const suffix = folderPath.map(encodeURIComponent).join('/');
  return `/folder/${encodeURIComponent(folderId)}${suffix === '' ? '' : `/${suffix}`}`;
}
