import { describe, expect, it } from 'vitest';
import {
  drivePath,
  folderPagePath,
  parseAppRoute,
  settingsPath,
  workspaceChatPath,
  workspaceChatTerminalPath,
  workspacePath,
} from '../src/sessions-page-state.js';

describe('settings routes', () => {
  it('routes the five sections, with profile as the index', () => {
    expect(parseAppRoute('/settings')).toEqual({
      workspaceId: null,
      page: 'settings',
      settingsSection: 'profile',
    });
    expect(parseAppRoute('/settings/members')).toEqual({
      workspaceId: null,
      page: 'settings',
      settingsSection: 'members',
    });
    expect(parseAppRoute('/settings/connections')).toEqual({
      workspaceId: null,
      page: 'settings',
      settingsSection: 'connections',
    });
    expect(parseAppRoute('/settings/compute')).toEqual({
      workspaceId: null,
      page: 'settings',
      settingsSection: 'compute',
    });
    expect(parseAppRoute('/settings/credentials')).toEqual({
      workspaceId: null,
      page: 'settings',
      settingsSection: 'credentials',
    });
    expect(parseAppRoute('/settings/files')).toEqual({
      workspaceId: null,
      page: 'drive',
    });
    expect(settingsPath('profile')).toBe('/settings');
    expect(settingsPath('members')).toBe('/settings/members');
    expect(settingsPath('connections')).toBe('/settings/connections');
    expect(settingsPath('compute')).toBe('/settings/compute');
    expect(settingsPath('credentials')).toBe('/settings/credentials');
  });

  // A settings link is pasted into chats and bookmarked, so an address for a
  // section that no longer exists resolves rather than blanks.
  it('resolves the three retired section addresses', () => {
    // Invites was the second half of one question and is a section of the
    // Members page now.
    for (const address of ['/settings/invites']) {
      expect(parseAppRoute(address), address).toEqual({
        workspaceId: null,
        page: 'settings',
        settingsSection: 'members',
      });
    }
    // Requests and Usage have no panel left, so they land on the index, which
    // is where an unknown settings address already landed.
    for (const address of ['/settings/requests/', '/settings/usage']) {
      expect(parseAppRoute(address), address).toEqual({
        workspaceId: null,
        page: 'settings',
        settingsSection: 'profile',
      });
    }
    // The pre-rename address stays routable and canonicalizes.
    expect(parseAppRoute('/settings/integrations')).toEqual({
      workspaceId: null,
      page: 'settings',
      settingsSection: 'connections',
    });
  });

  it('sends the disabled template and recipe addresses to Drive', () => {
    // Both surfaces are off product-wide (2026-08-29) and their control-plane
    // routes are unmounted, so an old bookmark lands on Drive rather than on a
    // page whose every request 404s.
    for (const address of [
      '/templates',
      '/templates/new',
      '/templates/t-1/edit',
      '/recipes',
      '/recipes/new',
      '/recipes/r-1/edit',
    ]) {
      expect(parseAppRoute(address), address).toEqual({ workspaceId: null, page: 'drive' });
    }
  });

  it('routes the drive home and folder pages, retiring the old shared address', () => {
    expect(parseAppRoute('/')).toEqual({ workspaceId: null, page: 'drive' });
    // Drive is one destination now; an old /shared bookmark lands on it.
    expect(parseAppRoute('/shared')).toEqual({ workspaceId: null, page: 'drive' });
    expect(parseAppRoute('/folder/f-1')).toEqual({
      workspaceId: null,
      page: 'folder',
      folderId: 'f-1',
      folderPath: [],
    });
    expect(parseAppRoute('/folder/f-1/raw/deep')).toEqual({
      workspaceId: null,
      page: 'folder',
      folderId: 'f-1',
      folderPath: ['raw', 'deep'],
    });
    expect(drivePath()).toBe('/');
    expect(folderPagePath('f-1', ['a b', 'c'])).toBe('/folder/f-1/a%20b/c');
    expect(parseAppRoute('/nonsense')).toEqual({ workspaceId: null, page: 'drive' });
  });

  // plans/LODY-SESSIONS.md §8: a chat session is an ADDRESS, and the address
  // bar is the only place the active selection persists. `webapp_state` never
  // learns about chat sessions — the daemon's list is what exists.
  it('routes the three chat states, and leaves the bare workspace address alone', () => {
    expect(parseAppRoute('/workspaces/ws-1')).toEqual({
      workspaceId: 'ws-1',
      page: 'webApp',
      chat: null,
    });
    expect(parseAppRoute('/workspaces/ws-1/')).toEqual({
      workspaceId: 'ws-1',
      page: 'webApp',
      chat: null,
    });
    expect(parseAppRoute('/workspaces/ws-1/chat')).toEqual({
      workspaceId: 'ws-1',
      page: 'webApp',
      chat: 'landing',
    });
    expect(parseAppRoute('/workspaces/ws-1/chat/')).toEqual({
      workspaceId: 'ws-1',
      page: 'webApp',
      chat: 'landing',
    });
    expect(parseAppRoute('/workspaces/ws-1/chat/s%201')).toEqual({
      workspaceId: 'ws-1',
      page: 'webApp',
      chat: { sessionId: 's 1' },
    });
    expect(workspacePath('ws-1')).toBe('/workspaces/ws-1');
    expect(workspaceChatPath('ws-1')).toBe('/workspaces/ws-1/chat');
    expect(workspaceChatPath('ws-1', 's 1')).toBe('/workspaces/ws-1/chat/s%201');
    // A deeper address is not a workspace address at all, so it falls to Drive
    // the way every unknown path does.
    expect(parseAppRoute('/workspaces/ws-1/chat/s-1/extra')).toEqual({
      workspaceId: null,
      page: 'drive',
    });
  });

  // plans/LODY-TERMINAL-TABS.md §4.2. A terminal is a tab of the SAME strip, so
  // its selection is an address too, and it has both of the strip's hosts.
  it('routes a terminal tab in both of the strip hosts, round trip', () => {
    expect(parseAppRoute('/workspaces/ws-1/chat/terminal/7')).toEqual({
      workspaceId: 'ws-1',
      page: 'webApp',
      chat: { terminalId: '7' },
    });
    expect(parseAppRoute('/workspaces/ws-1/chat/terminal/7/')).toEqual({
      workspaceId: 'ws-1',
      page: 'webApp',
      chat: { terminalId: '7' },
    });
    expect(parseAppRoute('/workspaces/ws-1/chat/s%201/terminal/7')).toEqual({
      workspaceId: 'ws-1',
      page: 'webApp',
      chat: { sessionId: 's 1', terminalId: '7' },
    });
    expect(workspaceChatTerminalPath('ws-1', '7')).toBe('/workspaces/ws-1/chat/terminal/7');
    expect(workspaceChatTerminalPath('ws-1', '7', 's 1'))
      .toBe('/workspaces/ws-1/chat/s%201/terminal/7');
  });

  // `terminal` is a reserved segment exactly as `shared` is. The two shapes
  // that could collide are stated here rather than left to be discovered.
  it('keeps a session literally named "terminal" distinguishable', () => {
    // Two segments after `chat` is a session, always — including this one.
    expect(parseAppRoute('/workspaces/ws-1/chat/terminal')).toEqual({
      workspaceId: 'ws-1',
      page: 'webApp',
      chat: { sessionId: 'terminal' },
    });
    expect(workspaceChatPath('ws-1', 'terminal')).toBe('/workspaces/ws-1/chat/terminal');
    // And that session's own terminal tab is four segments, which the
    // session-host pattern claims and the landing-host pattern cannot.
    expect(parseAppRoute('/workspaces/ws-1/chat/terminal/terminal/9')).toEqual({
      workspaceId: 'ws-1',
      page: 'webApp',
      chat: { sessionId: 'terminal', terminalId: '9' },
    });
    expect(workspaceChatTerminalPath('ws-1', '9', 'terminal'))
      .toBe('/workspaces/ws-1/chat/terminal/terminal/9');
  });
});
