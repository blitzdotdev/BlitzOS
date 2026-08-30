import { describe, expect, it } from 'vitest';
import { parseDiffFromFile } from '@pierre/diffs';
import { sessionFileProviderDiffResultToFileDiffData } from '../src/lib/session-file-provider-diff';

describe('sessionFileProviderDiffResultToFileDiffData', () => {
  it('maps provider text diff snapshots into conversation diff data', () => {
    expect(
      sessionFileProviderDiffResultToFileDiffData({
        status: 'ready',
        path: 'src/main.ts',
        oldSnapshot: { kind: 'text', text: 'old' },
        newSnapshot: { kind: 'text', text: 'new' },
      })
    ).toEqual({
      status: 'ready',
      oldSnapshot: { kind: 'text', text: 'old' },
      newSnapshot: { kind: 'text', text: 'new' },
    });
  });

  it('maps provider parsed text diffs into conversation parsed diff data', () => {
    const fileDiff = parseDiffFromFile(
      { name: 'src/main.ts', contents: 'old\n', lang: 'ts' },
      { name: 'src/main.ts', contents: 'old\nnew\n', lang: 'ts' }
    );
    expect(
      sessionFileProviderDiffResultToFileDiffData({
        status: 'ready-parsed',
        path: 'src/main.ts',
        fileDiff,
        oldTextLength: 4,
        newTextLength: 8,
      })
    ).toEqual({
      status: 'ready-parsed',
      fileDiff,
      oldTextLength: 4,
      newTextLength: 8,
    });
  });

  it('maps provider text chunk sources without reading chunks', () => {
    const source = {
      oldTextLength: 1024,
      newTextLength: 2048,
      readChunk: async () => '',
    };
    expect(
      sessionFileProviderDiffResultToFileDiffData({
        status: 'ready-text-source',
        path: 'src/main.ts',
        source,
      })
    ).toEqual({
      status: 'ready-text-source',
      source,
    });
  });

  it('maps provider binary snapshots into binary diff data', () => {
    expect(
      sessionFileProviderDiffResultToFileDiffData({
        status: 'ready',
        path: 'assets/logo.png',
        oldSnapshot: { kind: 'binary' },
        newSnapshot: { kind: 'binary', bytes: new Uint8Array([1]) },
      })
    ).toEqual({
      status: 'ready',
      oldSnapshot: { kind: 'binary' },
      newSnapshot: { kind: 'binary' },
    });
  });

  it('maps deleted and oversized snapshots into existing diff snapshot kinds', () => {
    expect(
      sessionFileProviderDiffResultToFileDiffData({
        status: 'ready',
        path: 'src/main.ts',
        oldSnapshot: { kind: 'unavailable', reason: 'deleted' },
        newSnapshot: { kind: 'unavailable', reason: 'text-too-large' },
      })
    ).toEqual({
      status: 'ready',
      oldSnapshot: { kind: 'missing' },
      newSnapshot: { kind: 'large' },
    });
  });

  it('keeps unavailable provider messages as diff errors', () => {
    expect(
      sessionFileProviderDiffResultToFileDiffData({
        status: 'unavailable',
        path: 'src/main.ts',
        reason: 'metadata-only',
        message: 'Turn history is missing.',
      })
    ).toEqual({
      status: 'error',
      message: 'Turn history is missing.',
    });
  });
});
