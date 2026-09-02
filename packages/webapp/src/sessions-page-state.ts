export type SettingsSection =
  | 'profile'
  | 'members'
  | 'invites'
  | 'connections'
  | 'credentials'
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
 * Four states, four spellings, no redundancy:
 *
 * - `null` — the panes own the view. `/workspaces/:id`.
 * - `'landing'` — the chat landing, which is the create surface, with no
 *   session selected. `/workspaces/:id/chat`.
 * - `{ sessionId }` — that session's detail page. `/workspaces/:id/chat/:id`.
 * - `'archive'` — the archived-session list, with its restore and its permanent
 *   delete. `/workspaces/:id/chat/archive`.
 *
 * THE ARCHIVE IS AN ADDRESS FOR THE REASON THE OTHER THREE ARE, plus one more.
 * The surface's own router cannot hold it alone: `mirror` reads the resolved
 * address back and a page that names no session reads as the landing, so a
 * surface-only archive would be pushed back to `/chat` on the navigation that
 * opened it. `archive` is a reserved segment exactly as `shared` and `terminal`
 * are — `workspaceChatPath` never emits a session id that spells it.
 *
 * A SHARED session carries one more field, and it is the OWNER's membership:
 * `{ sessionId, sharedFrom }` at `/workspaces/:id/chat/shared/:membershipId/:id`
 * (plans/LODY-SHARING.md §8 step 4). It has to be in the address for the same
 * reason the session id is — a reload or a deep link must land back on the same
 * screen — and it has to be beside the session id rather than derived from it,
 * because the control plane keeps no session list to derive it from
 * (`LODY-SHARING.md` §1.1) and the session's own box is the only thing that
 * knows. `shared` is a reserved first segment: a session id that literally
 * spells `shared` would otherwise be read as the prefix, so `workspaceChatPath`
 * never emits one and the parser requires the two segments that follow.
 *
 * A TERMINAL is a tab of the same strip (plans/LODY-TERMINAL-TABS.md §4.2), so
 * its selection is an address too, and it has both of the strip's hosts:
 *
 * - `{ terminalId }` — the chat landing's strip.
 *   `/workspaces/:id/chat/terminal/:tabId`.
 * - `{ sessionId, terminalId }` — that session's strip.
 *   `/workspaces/:id/chat/:sessionId/terminal/:tabId`.
 *
 * `terminal` is a reserved segment exactly as `shared` is, and for the same
 * reason. The selection does NOT ride Lody's own `?tab=` search parameter:
 * `parseSessionTabSearch` treats anything that is not `session:<id>` as
 * `invalid`, and `invalid` resets the whole vendored tab state — so a
 * `terminal:` value there would silently blank the session's own tab selection
 * on every navigation. It arrives as a prop instead, and the vendored URL
 * contract is untouched.
 */
export type ChatAddress =
  | null
  | 'landing'
  | 'archive'
  | ChatSessionAddress
  | ChatTerminalAddress;

/** One chat session: this member's own, or — with `sharedFrom` — one on the box
 * of the member that id names. */
export type ChatSessionAddress = { sessionId: string; sharedFrom?: string };

/** One workspace tab, selected in whichever host draws the strip: the chat
 * landing when `sessionId` is absent, that session's strip when it is not. */
export type ChatTerminalAddress = { terminalId: string; sessionId?: string };

/** Which arm of the union this is. `sharedFrom` lives on one of them only, so a
 * plain property read does not compile against the union. */
export function isChatTerminalAddress(chat: ChatAddress): chat is ChatTerminalAddress {
  return chat !== null && chat !== 'landing' && chat !== 'archive' && 'terminalId' in chat;
}

/** The two arms that name a PAGE rather than a session. Both are string
 * literals, so every `chat.sessionId` read narrows off this one predicate. */
export function isChatPageAddress(chat: ChatAddress): chat is 'landing' | 'archive' {
  return chat === 'landing' || chat === 'archive';
}

/** The OWNER's membership id when the address names a session another member
 * shared, and `undefined` for every other arm. */
export function chatSharedFrom(chat: ChatAddress): string | undefined {
  if (chat === null || isChatPageAddress(chat) || isChatTerminalAddress(chat)) return undefined;
  return chat.sharedFrom;
}

export type AppRoute =
  | { workspaceId: string; page: 'webApp'; chat: ChatAddress }
  | { workspaceId: null; page: 'drive' }
  | { workspaceId: null; page: 'folder'; folderId: string; folderPath: string[] }
  | { workspaceId: null; page: 'settings'; settingsSection: SettingsSection };

const HOME: AppRoute = { workspaceId: null, page: 'drive' };

export function parseAppRoute(pathname: string): AppRoute {
  const settings = pathname.match(/^\/settings(?:\/(profile|members|invites|connections|integrations|credentials|compute|requests|usage))?\/?$/u);
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
  const shared = pathname.match(/^\/workspaces\/([^/]+)\/chat\/shared\/([^/]+)\/([^/]+)\/?$/u);
  if (shared) {
    try {
      return {
        workspaceId: decodeURIComponent(shared[1]!),
        page: 'webApp',
        chat: {
          sessionId: decodeURIComponent(shared[3]!),
          sharedFrom: decodeURIComponent(shared[2]!),
        },
      };
    } catch {
      return HOME;
    }
  }
  // The two terminal arms, before the general chat pattern. `terminal` is a
  // reserved segment: `/chat/terminal/7` is terminal 7 on the landing, never a
  // session literally named `terminal` — the spelling for a session is
  // `/chat/<id>`, two segments, and it still parses that way below.
  const sessionTerminal = pathname.match(
    /^\/workspaces\/([^/]+)\/chat\/([^/]+)\/terminal\/([^/]+)\/?$/u,
  );
  if (sessionTerminal) {
    try {
      return {
        workspaceId: decodeURIComponent(sessionTerminal[1]!),
        page: 'webApp',
        chat: {
          sessionId: decodeURIComponent(sessionTerminal[2]!),
          terminalId: decodeURIComponent(sessionTerminal[3]!),
        },
      };
    } catch {
      return HOME;
    }
  }
  const landingTerminal = pathname.match(
    /^\/workspaces\/([^/]+)\/chat\/terminal\/([^/]+)\/?$/u,
  );
  if (landingTerminal) {
    try {
      return {
        workspaceId: decodeURIComponent(landingTerminal[1]!),
        page: 'webApp',
        chat: { terminalId: decodeURIComponent(landingTerminal[2]!) },
      };
    } catch {
      return HOME;
    }
  }
  // `archive` is a reserved segment, read before the general pattern below for
  // the reason `terminal` is: `/chat/archive` is the archived-session list,
  // never a session whose id literally spells `archive`.
  const archive = pathname.match(/^\/workspaces\/([^/]+)\/chat\/archive\/?$/u);
  if (archive) {
    try {
      return {
        workspaceId: decodeURIComponent(archive[1]!),
        page: 'webApp',
        chat: 'archive',
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

/** The archived-session list, with its restore and its permanent delete. */
export function workspaceChatArchivePath(workspaceId: string): string {
  return `${workspacePath(workspaceId)}/chat/archive`;
}

/** One workspace tab, in whichever host draws the strip. With no `sessionId`
 * this is the chat landing's strip; with one it is that session's. */
export function workspaceChatTerminalPath(
  workspaceId: string,
  terminalId: string,
  sessionId?: string,
): string {
  const base = `${workspacePath(workspaceId)}/chat`;
  const host = sessionId === undefined ? base : `${base}/${encodeURIComponent(sessionId)}`;
  return `${host}/terminal/${encodeURIComponent(terminalId)}`;
}

/** One session another member shared, on that member's machine. */
export function workspaceSharedChatPath(
  workspaceId: string,
  ownerMembershipId: string,
  sessionId: string,
): string {
  return `${workspacePath(workspaceId)}/chat/shared/${encodeURIComponent(ownerMembershipId)}/${encodeURIComponent(sessionId)}`;
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
