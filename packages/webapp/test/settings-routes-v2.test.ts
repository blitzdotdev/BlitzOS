import { describe, expect, it } from 'vitest';
import {
  drivePath,
  folderPagePath,
  parseAppRoute,
  settingsPath,
} from '../src/sessions-page-state.js';

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
    expect(parseAppRoute('/settings/compute')).toEqual({
      workspaceId: null,
      page: 'settings',
      settingsSection: 'compute',
    });
    expect(parseAppRoute('/settings/files')).toEqual({
      workspaceId: null,
      page: 'drive',
    });
    expect(parseAppRoute('/settings/usage')).toEqual({
      workspaceId: null,
      page: 'settings',
      settingsSection: 'usage',
    });
    expect(settingsPath('profile')).toBe('/settings');
    expect(settingsPath('connections')).toBe('/settings/connections');
    expect(settingsPath('requests')).toBe('/settings/requests');
    expect(settingsPath('compute')).toBe('/settings/compute');
    expect(settingsPath('usage')).toBe('/settings/usage');
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
});
