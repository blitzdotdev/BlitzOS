import { describe, expect, it } from 'vitest';
import { drivePath, folderPagePath, parseAppRoute, settingsPath } from '../src/sessions-page-state.js';

describe('settings routes', () => {
  it('routes profile, integrations, and requests with profile as the index', () => {
    expect(parseAppRoute('/settings')).toEqual({
      workspaceId: null,
      page: 'settings',
      settingsSection: 'profile',
    });
    expect(parseAppRoute('/settings/integrations')).toEqual({
      workspaceId: null,
      page: 'settings',
      settingsSection: 'integrations',
    });
    expect(parseAppRoute('/settings/requests/')).toEqual({
      workspaceId: null,
      page: 'settings',
      settingsSection: 'requests',
    });
    expect(parseAppRoute('/settings/files')).toEqual({
      workspaceId: null,
      page: 'drive',
      scope: 'mine',
    });
    expect(settingsPath('profile')).toBe('/settings');
    expect(settingsPath('integrations')).toBe('/settings/integrations');
    expect(settingsPath('requests')).toBe('/settings/requests');
  });

  it('routes the drive home, shared location, and folder pages', () => {
    expect(parseAppRoute('/')).toEqual({ workspaceId: null, page: 'drive', scope: 'mine' });
    expect(parseAppRoute('/shared')).toEqual({ workspaceId: null, page: 'drive', scope: 'shared' });
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
    expect(drivePath('mine')).toBe('/');
    expect(drivePath('shared')).toBe('/shared');
    expect(folderPagePath('f-1', ['a b', 'c'])).toBe('/folder/f-1/a%20b/c');
    expect(parseAppRoute('/nonsense')).toEqual({ workspaceId: null, page: 'drive', scope: 'mine' });
  });
});
