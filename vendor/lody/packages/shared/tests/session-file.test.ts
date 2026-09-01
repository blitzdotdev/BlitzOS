import { describe, expect, it } from 'vitest';

import {
  SESSION_FILE_PART_SIZE_BYTES,
  buildSessionFileApiUrl,
  buildSessionFileObjectKey,
  getSessionFileDownloadApiPath,
  getSessionFileMultipartAbortApiPath,
  getSessionFileMultipartCompleteApiPath,
  getSessionFileMultipartCreateApiPath,
  getSessionFileMultipartPartApiPath,
  getSessionFilePartCount,
  getSessionFilePreviewApiPath,
  getSessionFileUploadApiPath,
  shouldUseSingleShotUpload,
} from '../src/session-file';

describe('session-file part sizing', () => {
  it('uses single-shot upload at or below one part', () => {
    expect(shouldUseSingleShotUpload(0)).toBe(true);
    expect(shouldUseSingleShotUpload(1)).toBe(true);
    expect(shouldUseSingleShotUpload(SESSION_FILE_PART_SIZE_BYTES)).toBe(true);
  });

  it('requires multipart above one part', () => {
    expect(shouldUseSingleShotUpload(SESSION_FILE_PART_SIZE_BYTES + 1)).toBe(false);
  });

  it('computes part counts', () => {
    expect(getSessionFilePartCount(0)).toBe(0);
    expect(getSessionFilePartCount(1)).toBe(1);
    expect(getSessionFilePartCount(SESSION_FILE_PART_SIZE_BYTES)).toBe(1);
    expect(getSessionFilePartCount(SESSION_FILE_PART_SIZE_BYTES + 1)).toBe(2);
    expect(getSessionFilePartCount(SESSION_FILE_PART_SIZE_BYTES * 3)).toBe(3);
    // 100 MB ceiling stays at a small part count.
    expect(getSessionFilePartCount(100 * 1024 * 1024)).toBe(7);
  });
});

describe('session-file API paths', () => {
  it('builds the single-shot upload path', () => {
    expect(getSessionFileUploadApiPath('ws')).toBe('/api/workspaces/ws/session-files/upload');
  });

  it('builds multipart paths', () => {
    expect(getSessionFileMultipartCreateApiPath('ws')).toBe(
      '/api/workspaces/ws/session-files/multipart/create'
    );
    expect(getSessionFileMultipartPartApiPath('ws', 'up1', 3)).toBe(
      '/api/workspaces/ws/session-files/multipart/up1/part/3'
    );
    expect(getSessionFileMultipartCompleteApiPath('ws', 'up1')).toBe(
      '/api/workspaces/ws/session-files/multipart/up1/complete'
    );
    expect(getSessionFileMultipartAbortApiPath('ws', 'up1')).toBe(
      '/api/workspaces/ws/session-files/multipart/up1'
    );
  });

  it('builds download and preview paths', () => {
    expect(getSessionFileDownloadApiPath('ws', 'sess', 'file1')).toBe(
      '/api/workspaces/ws/session-files/sess/file1'
    );
    expect(getSessionFilePreviewApiPath('ws', 'sess', 'file1')).toBe(
      '/api/workspaces/ws/session-files/sess/file1/preview'
    );
  });

  it('encodes path segments defensively', () => {
    expect(getSessionFileDownloadApiPath('ws/with space', 'sess', 'f')).toBe(
      '/api/workspaces/ws%2Fwith%20space/session-files/sess/f'
    );
  });

  it('joins base url and path, trimming a trailing slash', () => {
    expect(buildSessionFileApiUrl('https://server.example.test/', '/api/x')).toBe(
      'https://server.example.test/api/x'
    );
    expect(buildSessionFileApiUrl('https://server.example.test', '/api/x')).toBe(
      'https://server.example.test/api/x'
    );
  });

  it('builds the relay-store object key', () => {
    expect(buildSessionFileObjectKey('ws', 'sess', 'file1')).toBe('session-files/ws/sess/file1');
  });
});
