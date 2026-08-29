import { describe, expect, it, vi } from 'vitest';
import type { LoroRepo } from 'loro-repo';

import { listDocMetaEntries } from '../src/lib/doc-meta-batch';

describe('listDocMetaEntries', () => {
  it('hydrates metadata with batched Flock prefix scans', async () => {
    const scan = vi.fn(async ({ prefix }: { prefix?: readonly unknown[] } = {}) => {
      if (prefix?.[0] === 'm') {
        return [
          { key: ['m', 'machine-1'], value: { id: 'machine-1', name: 'dev-box' } },
          { key: ['m', 'machine-1', 'lastSeen'], value: 2 },
          { key: ['m', 'machine-deleted'], value: { id: 'machine-deleted' } },
        ];
      }
      if (prefix?.[0] === 'e') {
        return [
          { key: ['e', 'machine-1'], value: true },
          { key: ['e', 'machine-deleted'], value: false },
        ];
      }
      return [];
    });
    const listDoc = vi.fn(async () => {
      throw new Error('listDoc fallback should not run');
    });
    const repo = {
      getMeta: () => ({ scan }),
      listDoc,
    } as unknown as LoroRepo;

    await expect(listDocMetaEntries(repo)).resolves.toEqual([
      {
        docId: 'machine-1',
        exists: true,
        meta: { id: 'machine-1', name: 'dev-box', lastSeen: 2 },
      },
    ]);
    expect(scan).toHaveBeenCalledWith({ prefix: ['m'] });
    expect(scan).toHaveBeenCalledWith({ prefix: ['e'] });
    expect(listDoc).not.toHaveBeenCalled();
  });

  it('skips metadata rows without an active existence marker', async () => {
    const scan = vi.fn(async ({ prefix }: { prefix?: readonly unknown[] } = {}) => {
      if (prefix?.[0] === 'm') {
        return [
          { key: ['m', 'machine-active'], value: { id: 'machine-active' } },
          { key: ['m', 'machine-metadata-only'], value: { id: 'machine-metadata-only' } },
          { key: ['m', 'machine-deleted'], value: { id: 'machine-deleted' } },
          { key: ['m', 'machine-missing'], value: { id: 'machine-missing' } },
        ];
      }
      if (prefix?.[0] === 'e') {
        return [
          { key: ['e', 'machine-active'], value: true },
          { key: ['e', 'machine-deleted'], value: false },
          { key: ['e', 'machine-missing'] },
        ];
      }
      return [];
    });
    const repo = {
      getMeta: () => ({ scan }),
      listDoc: vi.fn(async () => []),
    } as unknown as LoroRepo;

    await expect(listDocMetaEntries(repo)).resolves.toEqual([
      {
        docId: 'machine-active',
        exists: true,
        meta: { id: 'machine-active' },
      },
    ]);
  });

  it('falls back to repo.listDoc when direct Flock scanning is unavailable', async () => {
    const listDoc = vi.fn(async () => [
      {
        docId: 'machine-fallback',
        meta: { id: 'machine-fallback', name: 'fallback' },
      },
    ]);
    const repo = { listDoc } as unknown as LoroRepo;

    await expect(listDocMetaEntries(repo)).resolves.toEqual([
      {
        docId: 'machine-fallback',
        meta: { id: 'machine-fallback', name: 'fallback' },
      },
    ]);
  });
});
