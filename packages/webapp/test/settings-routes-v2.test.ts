import { describe, expect, it } from 'vitest';
import { parseAppRoute, settingsPath } from '../src/sessions-page-state.js';

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
      page: 'settings',
      settingsSection: 'files',
    });
    expect(settingsPath('profile')).toBe('/settings');
    expect(settingsPath('integrations')).toBe('/settings/integrations');
    expect(settingsPath('requests')).toBe('/settings/requests');
    expect(settingsPath('files')).toBe('/settings/files');
  });
});
