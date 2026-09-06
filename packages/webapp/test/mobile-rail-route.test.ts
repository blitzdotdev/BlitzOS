import { describe, expect, it } from 'vitest';
import { routeShowsMobileRail } from '../src/shell/mobile-rail.js';
import type { AppRoute, ChatAddress } from '../src/sessions-page-state.js';

const workspaceRoute = (chat: ChatAddress): AppRoute => ({
  workspaceId: 'workspace-one',
  page: 'webApp',
  chat,
});

describe('routeShowsMobileRail', () => {
  it('shows the rail only for the workspace landing', () => {
    expect(routeShowsMobileRail(workspaceRoute('landing'))).toBe(true);
  });

  it.each([
    ['pane workspace', workspaceRoute(null)],
    ['archive', workspaceRoute('archive')],
    ['session', workspaceRoute({ sessionId: 'session-one' })],
    ['shared session', workspaceRoute({ sessionId: 'session-two', sharedFrom: 'member-two' })],
    ['landing terminal', workspaceRoute({ terminalId: 'terminal-one' })],
    ['session terminal', workspaceRoute({ sessionId: 'session-one', terminalId: 'terminal-two' })],
    ['home', { workspaceId: null, page: 'home' }],
    ['settings', { workspaceId: null, page: 'settings', settingsSection: 'profile' }],
  ] satisfies ReadonlyArray<readonly [string, AppRoute]>)('hides the rail for %s', (_name, route) => {
    expect(routeShowsMobileRail(route)).toBe(false);
  });
});
