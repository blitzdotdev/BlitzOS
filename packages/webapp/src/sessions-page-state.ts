export type SettingsSection =
  | 'profile'
  | 'members'
  | 'invites'
  | 'connections'
  | 'compute'
  | 'requests'
  | 'usage';

export type DriveScope = 'mine' | 'shared';

/**
 * Where the Lody session surface stands, as an address
 * (plans/LODY-SESSIONS.md §8, phase 4).
 *
 * THE URL IS THE ONLY PLACE THIS PERSISTS, and that is the decision phase 4
 * makes. `webapp_state` owns terminal tabs and pane layout and must not learn
 * about chat sessions: the daemon's session list is the source of truth for
 * WHICH sessions exist, and a stale id in a shared D1 document would point half
 * the workspace's members at a session that was archived on somebody else's box.
 * What may persist is the ACTIVE SELECTION, and the address bar already persists
 * every other selection this app has — the Drive folder, the settings section —
 * across a reload, a deep link and the back button, with no server round trip
 * and no cross-member leakage.
 *
 * Three states, three spellings, no redundancy:
 *
 * - `null` — the panes own the view. `/workspaces/:id`.
 * - `'landing'` — the chat landing, which is the create surface, with no
 *   session selected. `/workspaces/:id/chat`.
 * - `{ sessionId }` — that session's detail page. `/workspaces/:id/chat/:id`.
 */
export type ChatAddress = null | 'landing' | { sessionId: string };

export type AppRoute =
  | { workspaceId: string; page: 'webApp'; chat: ChatAddress }
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
  const match = pathname.match(/^\/workspaces\/([^/]+)(?:\/chat(?:\/([^/]+))?)?\/?$/u);
  if (!match) return HOME;
  try {
    const sessionId = match[2] === undefined ? null : decodeURIComponent(match[2]);
    // `/chat` with no id is the landing; `/chat/<id>` is that session. A bare
    // `/workspaces/:id` keeps meaning the panes, so every existing link and
    // every bookmark resolves exactly where it did before.
    const chat: ChatAddress = sessionId !== null
      ? { sessionId }
      : /\/chat\/?$/u.test(pathname) ? 'landing' : null;
    return {
      workspaceId: decodeURIComponent(match[1]!),
      page: 'webApp',
      chat,
    };
  } catch {
    return HOME;
  }
}

export function workspacePath(workspaceId: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}`;
}

/** The chat landing, or one session inside a workspace. See {@link ChatAddress}. */
export function workspaceChatPath(workspaceId: string, sessionId?: string): string {
  const base = `${workspacePath(workspaceId)}/chat`;
  return sessionId === undefined ? base : `${base}/${encodeURIComponent(sessionId)}`;
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
