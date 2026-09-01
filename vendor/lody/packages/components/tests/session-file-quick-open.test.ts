import { describe, expect, it, vi } from 'vitest';
import {
  filterSessionFileQuickOpenFallbackPaths,
  loadSessionFileQuickOpenItems,
  mapSessionFileProviderEntriesToQuickOpenItems,
  shouldVirtualizeSessionFileQuickOpenItems,
} from '../src/components/sessions/session-file-quick-open';
import { createFakeSessionFileProvider } from '../src/lib/session-file-provider';
import { createSessionFileProviderFromSource } from '../src/lib/session-file-provider-selection';

describe('session file quick open helpers', () => {
  it('deduplicates, sorts, filters, and limits fallback paths', () => {
    expect(
      filterSessionFileQuickOpenFallbackPaths(
        ['src/b.ts', 'README.md', 'src/a.ts', 'src/a.ts', ''],
        'src/',
        2
      )
    ).toEqual([{ path: 'src/a.ts' }, { path: 'src/b.ts' }]);
  });

  it('returns the first fallback paths for an empty query', () => {
    expect(filterSessionFileQuickOpenFallbackPaths(['b.ts', 'a.ts', 'c.ts'], '', 2)).toEqual([
      { path: 'a.ts' },
      { path: 'b.ts' },
    ]);
  });

  it('maps provider entries without leaking provider-only fields into UI items', () => {
    expect(
      mapSessionFileProviderEntriesToQuickOpenItems(
        [
          {
            fileId: 'file-1',
            path: 'src/main.ts',
            kind: 'text',
            sourceState: 'live-collaborative',
          },
          {
            path: 'package.json',
            kind: 'text',
            sourceState: 'live-readonly',
            readonly: true,
          },
        ],
        10
      )
    ).toEqual([
      { fileId: 'file-1', path: 'src/main.ts' },
      { path: 'package.json', readonly: true },
    ]);
  });

  it('does not truncate provider results by default', () => {
    const entries = Array.from({ length: 75 }, (_, index) => ({
      fileId: `file-${index}`,
      path: `src/file-${index}.ts`,
      kind: 'text' as const,
      sourceState: 'live-collaborative' as const,
    }));

    expect(mapSessionFileProviderEntriesToQuickOpenItems(entries)).toHaveLength(75);
    expect(mapSessionFileProviderEntriesToQuickOpenItems(entries, 50)).toHaveLength(50);
  });

  it('virtualizes dense result lists after the fixed compact threshold', () => {
    expect(shouldVirtualizeSessionFileQuickOpenItems(50)).toBe(false);
    expect(shouldVirtualizeSessionFileQuickOpenItems(51)).toBe(true);
  });

  it('uses provider search results instead of fallback paths when a provider is ready', async () => {
    const provider = createFakeSessionFileProvider({
      files: [
        {
          fileId: 'provider-file',
          path: 'src/provider-only.ts',
          kind: 'text',
          sourceState: 'live-collaborative',
        },
      ],
    });
    const searchFiles = vi.spyOn(provider, 'searchFiles');

    await expect(
      loadSessionFileQuickOpenItems({
        provider,
        fallbackPaths: ['src/fallback-only.ts'],
        query: '',
      })
    ).resolves.toEqual([{ fileId: 'provider-file', path: 'src/provider-only.ts' }]);

    expect(searchFiles).toHaveBeenCalledWith('');
  });

  it('surfaces an unavailable provider message instead of falling back silently', async () => {
    const provider = createSessionFileProviderFromSource({
      kind: 'none',
      message: 'Host start failed.',
    });

    await expect(
      loadSessionFileQuickOpenItems({
        provider,
        fallbackPaths: ['src/fallback-only.ts'],
        query: '',
      })
    ).rejects.toThrow('Host start failed.');
  });

  it('falls back to static paths before a provider is ready', async () => {
    await expect(
      loadSessionFileQuickOpenItems({
        provider: null,
        fallbackPaths: ['b.ts', 'a.ts'],
        query: 'a',
      })
    ).resolves.toEqual([{ path: 'a.ts' }]);
  });
});
