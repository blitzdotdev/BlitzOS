import { describe, expect, it } from 'vitest';
import {
  canOpenHistoricalSessionDiffs,
  createFakeSessionFileProvider,
} from '../src/lib/session-file-provider';

describe('session file provider contract', () => {
  it('lists, searches, and opens files by path or file id', async () => {
    const provider = createFakeSessionFileProvider({
      files: [
        {
          fileId: 't:readme',
          path: 'README.md',
          kind: 'text',
          sourceState: 'live-collaborative',
        },
        {
          fileId: 't:source',
          path: 'src/index.ts',
          kind: 'text',
          sourceState: 'live-collaborative',
        },
      ],
      snapshots: {
        'README.md': { kind: 'text', text: '# Hello' },
        'src/index.ts': { kind: 'text', text: 'export {}' },
      },
    });

    expect((await provider.listFiles()).map((file) => file.path)).toEqual([
      'README.md',
      'src/index.ts',
    ]);
    expect((await provider.searchFiles('index')).map((file) => file.path)).toEqual([
      'src/index.ts',
    ]);
    expect(await provider.getFile('t:readme')).toMatchObject({ path: 'README.md' });
    expect(await provider.openFile('README.md')).toMatchObject({
      status: 'ready',
      snapshot: { kind: 'text', text: '# Hello' },
    });
  });

  it('returns degraded open and save states without throwing', async () => {
    const provider = createFakeSessionFileProvider({
      files: [
        {
          fileId: 't:huge',
          path: 'huge.txt',
          kind: 'large',
          sourceState: 'degraded',
          unavailableReason: 'text-too-large',
          readonly: true,
        },
      ],
    });

    expect(await provider.openFile('huge.txt')).toEqual({
      status: 'unavailable',
      entry: expect.objectContaining({ path: 'huge.txt' }),
      reason: 'text-too-large',
    });
    expect(await provider.saveText('huge.txt', 'new')).toEqual({
      status: 'unavailable',
      entry: expect.objectContaining({ path: 'huge.txt' }),
      reason: 'permission-denied',
    });
  });

  it('lists provider changed files globally and by turn', async () => {
    const provider = createFakeSessionFileProvider({
      changedFiles: [
        {
          fileId: 't:source',
          path: 'src/index.ts',
          kind: 'text',
          sourceState: 'live-collaborative',
          add: 2,
          del: 1,
        },
      ],
      changedFilesByTurn: {
        'turn-1': [
          {
            fileId: 't:readme',
            path: 'README.md',
            kind: 'text',
            sourceState: 'historical-turn',
          },
        ],
      },
    });

    expect(await provider.listChangedFiles()).toEqual({
      status: 'ready',
      files: [expect.objectContaining({ path: 'src/index.ts', add: 2, del: 1 })],
    });
    expect(await provider.listChangedFiles('turn-1')).toEqual({
      status: 'ready',
      files: [expect.objectContaining({ path: 'README.md' })],
    });
    expect(await provider.listChangedFiles('turn-missing')).toEqual({ status: 'ready', files: [] });
  });

  it('requires an explicit capability before opening historical diffs', () => {
    expect(canOpenHistoricalSessionDiffs(null)).toBe(false);
    expect(canOpenHistoricalSessionDiffs(createFakeSessionFileProvider())).toBe(false);
    expect(
      canOpenHistoricalSessionDiffs(
        createFakeSessionFileProvider({
          supportsHistoricalDiffs: true,
        })
      )
    ).toBe(true);
  });
});
