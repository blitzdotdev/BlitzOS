import { describe, expect, it } from 'vitest';
import { buildMentionFilePathsEntryFromProviderEntries } from '../src/components/mentions/mention-project-file-source';

describe('buildMentionFilePathsEntryFromProviderEntries', () => {
  it('deduplicates and sorts provider file paths for mention indexing', () => {
    expect(
      buildMentionFilePathsEntryFromProviderEntries(
        [
          {
            fileId: 'file-b',
            path: 'src/b.ts',
            kind: 'text',
            sourceState: 'live-collaborative',
          },
          {
            fileId: 'file-a',
            path: 'src/a.ts',
            kind: 'text',
            sourceState: 'live-collaborative',
          },
          {
            fileId: 'file-a-again',
            path: 'src/a.ts',
            kind: 'text',
            sourceState: 'live-collaborative',
          },
        ],
        123
      )
    ).toEqual({
      paths: ['src/a.ts', 'src/b.ts'],
      truncated: false,
      fetchedAt: 123,
    });
  });

  it('keeps lazy directories as structured mention entries', () => {
    expect(
      buildMentionFilePathsEntryFromProviderEntries(
        [
          {
            entryType: 'lazy-directory',
            directoryId: 'src',
            path: 'src',
            kind: 'special',
            sourceState: 'live-collaborative',
          },
          {
            entryType: 'file',
            fileId: 'readme',
            path: 'README.md',
            kind: 'text',
            sourceState: 'live-collaborative',
          },
        ],
        456
      )
    ).toEqual({
      paths: ['README.md'],
      lazyDirectories: [{ path: 'src', directoryId: 'src' }],
      truncated: false,
      fetchedAt: 456,
    });
  });

  it('reuses the previous entry when provider file contents are unchanged', () => {
    const entries = [
      {
        entryType: 'lazy-directory' as const,
        directoryId: 'src',
        path: 'src',
        kind: 'special' as const,
        sourceState: 'live-collaborative' as const,
      },
      {
        entryType: 'file' as const,
        fileId: 'readme',
        path: 'README.md',
        kind: 'text' as const,
        sourceState: 'live-collaborative' as const,
      },
    ];
    const first = buildMentionFilePathsEntryFromProviderEntries(entries, 1);
    const second = buildMentionFilePathsEntryFromProviderEntries([...entries].reverse(), 2, first);

    expect(second).toBe(first);
  });

  it('creates a new entry when provider file contents change', () => {
    const first = buildMentionFilePathsEntryFromProviderEntries(
      [
        {
          fileId: 'readme',
          path: 'README.md',
          kind: 'text',
          sourceState: 'live-collaborative',
        },
      ],
      1
    );
    const second = buildMentionFilePathsEntryFromProviderEntries(
      [
        {
          fileId: 'readme',
          path: 'README.md',
          kind: 'text',
          sourceState: 'live-collaborative',
        },
        {
          fileId: 'package',
          path: 'package.json',
          kind: 'text',
          sourceState: 'live-collaborative',
        },
      ],
      2,
      first
    );

    expect(second).not.toBe(first);
    expect(second.paths).toEqual(['package.json', 'README.md']);
  });
});
