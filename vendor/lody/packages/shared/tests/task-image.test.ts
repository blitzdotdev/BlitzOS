import { describe, expect, it } from 'vitest';
import {
  buildTaskImageMarkdownUrl,
  buildTaskImageObjectKey,
  extractTaskImageIdsFromMarkdown,
  getTaskImageDownloadApiPath,
  getTaskImageUploadApiPath,
  parseTaskImageMarkdownUrl,
} from '../src/task-image';

describe('task image helpers', () => {
  it('builds workspace-scoped API and object paths', () => {
    expect(getTaskImageUploadApiPath('workspace id')).toBe(
      '/api/workspaces/workspace%20id/task-images/upload'
    );
    expect(getTaskImageDownloadApiPath('workspace id', 'image-id')).toBe(
      '/api/workspaces/workspace%20id/task-images/image-id'
    );
    expect(buildTaskImageObjectKey('workspace', 'image-id')).toBe('task-images/workspace/image-id');
  });

  it('round-trips stable markdown references', () => {
    const reference = buildTaskImageMarkdownUrl('image-id');
    expect(reference).toBe('lody-image://image-id');
    expect(parseTaskImageMarkdownUrl(reference)).toBe('image-id');
    expect(parseTaskImageMarkdownUrl('https://example.com/image.png')).toBeNull();
    expect(parseTaskImageMarkdownUrl('lody-image://bad/id')).toBeNull();
  });

  it('extracts unique image ids from markdown', () => {
    expect(
      extractTaskImageIdsFromMarkdown(
        '![first](lody-image://one)\n![again](lody-image://one)\n![second](lody-image://two)'
      )
    ).toEqual(['one', 'two']);
  });
});
