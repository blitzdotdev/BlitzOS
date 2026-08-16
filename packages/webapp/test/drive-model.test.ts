import { describe, expect, it } from 'vitest';
import type { FolderView } from '../src/file-library-api.js';
import {
  entriesAt,
  normalizeFolderName,
  splitFolders,
} from '../src/files/drive-model.js';

function folder(id: string, role: FolderView['role']): FolderView {
  return {
    id,
    name: id,
    role,
    owner: { name: 'Owner', avatarUrl: null },
    attachedWorkspaceIds: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('drive model', () => {
  it('puts owned folders in My Drive, everything accessible elsewhere in Shared with me', () => {
    const { mine, shared } = splitFolders([
      folder('own', 'owner'),
      folder('granted', 'editor'),
      folder('viewed', 'viewer'),
      folder('admin', 'admin'),
      folder('hidden', null),
    ]);
    expect(mine.map(({ id }) => id)).toEqual(['own']);
    expect(shared.map(({ id }) => id)).toEqual(['granted', 'viewed', 'admin']);
  });

  it('derives one directory level from flat keys, directories first', () => {
    const objects = [
      { key: 'b.txt', size: 1, mtime: 1, editedBy: 'x' },
      { key: 'raw/one.parquet', size: 1, mtime: 1, editedBy: 'x' },
      { key: 'raw/two.parquet', size: 1, mtime: 1, editedBy: 'x' },
      { key: 'raw/deep/three.parquet', size: 1, mtime: 1, editedBy: 'x' },
      { key: 'a.txt', size: 1, mtime: 1, editedBy: 'x' },
    ];
    const root = entriesAt(objects, []);
    expect(root.dirs).toEqual([{ name: 'raw', fileCount: 3 }]);
    expect(root.files.map(({ name }) => name)).toEqual(['a.txt', 'b.txt']);
    const raw = entriesAt(objects, ['raw']);
    expect(raw.dirs).toEqual([{ name: 'deep', fileCount: 1 }]);
    expect(raw.files.map(({ name }) => name)).toEqual(['one.parquet', 'two.parquet']);
  });

  it('normalizes folder names to the materialization-safe slug', () => {
    expect(normalizeFolderName('  Research Notes! ')).toBe('research-notes');
    expect(normalizeFolderName('--Data Sets--')).toBe('data-sets');
    expect(normalizeFolderName('###')).toBe('');
    expect(normalizeFolderName('ok-1.2_x')).toBe('ok-1.2_x');
  });
});
