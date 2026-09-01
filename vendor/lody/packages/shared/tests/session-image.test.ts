import { describe, expect, it } from 'vitest';

import {
  getSessionImageDownloadApiPath,
  getSessionImageThumbnailApiPath,
  isValidSessionImagePathSegment,
  parseSessionImageThumbnailOptions,
} from '../src/session-image';

describe('session-image thumbnail path', () => {
  it('builds thumbnail path from encoded session image path', () => {
    const downloadPath = getSessionImageDownloadApiPath('workspace id', 'session id', 'image/id');
    expect(downloadPath).toBe(
      '/api/workspaces/workspace%20id/session-images/session%20id/image%2Fid'
    );

    expect(
      getSessionImageThumbnailApiPath('workspace id', 'session id', 'image/id', {
        width: 180,
      })
    ).toBe(
      '/api/workspaces/workspace%20id/session-images/session%20id/image%2Fid/thumbnail?width=180&fit=scale-down&quality=85'
    );
  });

  it('normalizes thumbnail api query options', () => {
    expect(
      getSessionImageThumbnailApiPath('workspace', 'session', 'image', {
        width: Number.NaN,
        height: 100000,
        fit: 'cover',
        quality: 0,
      })
    ).toBe(
      '/api/workspaces/workspace/session-images/session/image/thumbnail?width=512&height=4096&fit=cover&quality=1'
    );
  });

  it('round-trips the builder query back through the server-side parser', () => {
    const path = getSessionImageThumbnailApiPath('workspace', 'session', 'image', {
      width: 180,
      height: 120,
      fit: 'cover',
      quality: 90,
    });
    const searchParams = new URLSearchParams(path.slice(path.indexOf('?')));

    expect(parseSessionImageThumbnailOptions(searchParams)).toEqual({
      width: 180,
      height: 120,
      fit: 'cover',
      quality: 90,
    });
  });

  it('clamps untrusted thumbnail query options the same way the builder does', () => {
    expect(
      parseSessionImageThumbnailOptions(
        new URLSearchParams({ width: 'nope', height: '100000', fit: 'squish', quality: '0' })
      )
    ).toEqual({ width: 512, height: 4096, fit: 'scale-down', quality: 1 });

    // Absent height keeps the aspect ratio; a blank one falls back to the width.
    expect(parseSessionImageThumbnailOptions(new URLSearchParams({ width: '180' }))).toEqual({
      width: 180,
      height: undefined,
      fit: 'scale-down',
      quality: 85,
    });
    expect(
      parseSessionImageThumbnailOptions(new URLSearchParams({ width: '180', height: '' }))
    ).toEqual({ width: 180, height: 180, fit: 'scale-down', quality: 85 });
  });

  it('validates safe session image path segments', () => {
    expect(isValidSessionImagePathSegment('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    expect(isValidSessionImagePathSegment('img_1-2')).toBe(true);
    expect(isValidSessionImagePathSegment('')).toBe(false);
    expect(isValidSessionImagePathSegment('session id')).toBe(false);
    expect(isValidSessionImagePathSegment('session/id')).toBe(false);
    expect(isValidSessionImagePathSegment('../session')).toBe(false);
    expect(isValidSessionImagePathSegment('x'.repeat(129))).toBe(false);
  });
});
