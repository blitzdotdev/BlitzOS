import { describe, expect, it } from 'vitest';
import {
  drivePath,
  folderPagePath,
  parseAppRoute,
  recipeEditPath,
  recipeNewPath,
  recipesPath,
  settingsPath,
} from '../src/sessions-page-state.js';

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
    });
    expect(parseAppRoute('/settings/usage')).toEqual({
      workspaceId: null,
      page: 'settings',
      settingsSection: 'usage',
    });
    expect(settingsPath('profile')).toBe('/settings');
    expect(settingsPath('integrations')).toBe('/settings/integrations');
    expect(settingsPath('requests')).toBe('/settings/requests');
    expect(settingsPath('usage')).toBe('/settings/usage');
  });

  it('routes the recipes pages with new winning over the id match', () => {
    expect(parseAppRoute('/recipes')).toEqual({ workspaceId: null, page: 'recipes' });
    expect(parseAppRoute('/recipes/new')).toEqual({ workspaceId: null, page: 'recipe-new' });
    expect(parseAppRoute('/recipes/r-1/edit')).toEqual({
      workspaceId: null,
      page: 'recipe-edit',
      recipeId: 'r-1',
    });
    expect(recipesPath()).toBe('/recipes');
    expect(recipeNewPath()).toBe('/recipes/new');
    expect(recipeEditPath('r 1')).toBe('/recipes/r%201/edit');
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
