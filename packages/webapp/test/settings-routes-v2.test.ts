import { describe, expect, it } from 'vitest';
import { drivePath, folderPagePath, parseAppRoute, settingsPath } from '../src/sessions-page-state.js';

describe('settings routes', () => {
  it('routes profile, connections, and requests with profile as the index', () => {
    expect(parseAppRoute('/settings')).toEqual({
      workspaceId: null,
      page: 'settings',
      settingsSection: 'profile',
    });
    expect(parseAppRoute('/settings/connections')).toEqual({
      workspaceId: null,
      page: 'settings',
      settingsSection: 'connections',
    });
    // The pre-rename address stays routable and canonicalizes.
    expect(parseAppRoute('/settings/integrations')).toEqual({
      workspaceId: null,
      page: 'settings',
      settingsSection: 'connections',
    });
    expect(parseAppRoute('/settings/requests/')).toEqual({
      workspaceId: null,
      page: 'settings',
      settingsSection: 'requests',
    });
    expect(parseAppRoute('/settings/files')).toEqual({
      workspaceId: null,
      page: 'drive',
    });
    expect(settingsPath('profile')).toBe('/settings');
    expect(settingsPath('connections')).toBe('/settings/connections');
    expect(settingsPath('requests')).toBe('/settings/requests');
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
});
