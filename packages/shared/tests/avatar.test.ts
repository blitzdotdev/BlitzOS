import { describe, expect, it } from 'vitest';

import {
  buildAvatarObjectKey,
  getAvatarDownloadApiPath,
  getAvatarUploadApiPath,
  isAvatarKind,
  isAvatarUploadApiPath,
  isValidAvatarId,
  parseAvatarDownloadPath,
} from '../src/avatar';

describe('avatar path helpers', () => {
  it('builds the workspace-scoped upload path', () => {
    expect(getAvatarUploadApiPath('ws 1')).toBe('/api/workspaces/ws%201/avatars/upload');
  });

  it('recognizes the upload sub-path', () => {
    expect(isAvatarUploadApiPath('/avatars/upload')).toBe(true);
    expect(isAvatarUploadApiPath('/avatars/other')).toBe(false);
  });

  it('builds a public download path from an id', () => {
    expect(getAvatarDownloadApiPath('abc-123')).toBe('/api/avatars/abc-123');
  });

  it('builds the R2 object key', () => {
    expect(buildAvatarObjectKey('abc-123')).toBe('avatars/abc-123');
  });

  it('parses a valid download path', () => {
    expect(parseAvatarDownloadPath('/api/avatars/abc-123')).toEqual({
      kind: 'matched',
      avatarId: 'abc-123',
    });
  });

  it('rejects unrelated paths and invalid ids', () => {
    expect(parseAvatarDownloadPath('/api/other/x')).toEqual({ kind: 'none' });
    expect(parseAvatarDownloadPath('/api/avatars/a/b')).toEqual({ kind: 'none' });
    expect(parseAvatarDownloadPath('/api/avatars/bad id!')).toEqual({ kind: 'invalid' });
  });

  it('validates ids and kinds', () => {
    expect(isValidAvatarId('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    expect(isValidAvatarId('has space')).toBe(false);
    expect(isAvatarKind('user')).toBe(true);
    expect(isAvatarKind('workspace')).toBe(true);
    expect(isAvatarKind('nope')).toBe(false);
  });
});
