import { parseDiffFromFile } from '@pierre/diffs';
import { describe, expect, it } from 'vitest';
import {
  boundParsedFileDiffForMainThread,
  measureParsedFileDiffComplexity,
  stripParsedFileDiffFullText,
} from '../src/lib/code-collab-diff-metadata-bounds';

describe('Code Collab parsed diff metadata bounds', () => {
  it('strips full old/new file lines before returning parsed diff metadata to the main thread', () => {
    const fileDiff = parseDiffFromFile(
      { name: 'src/example.ts', contents: 'old\n'.repeat(8), lang: 'ts' },
      {
        name: 'src/example.ts',
        contents: `${'old\n'.repeat(4)}new\n${'old\n'.repeat(3)}`,
        lang: 'ts',
      }
    );

    expect(fileDiff.oldLines?.length).toBeGreaterThan(0);
    expect(fileDiff.newLines?.length).toBeGreaterThan(0);

    const stripped = stripParsedFileDiffFullText(fileDiff);

    expect('oldLines' in stripped).toBe(false);
    expect('newLines' in stripped).toBe(false);
    expect(stripped.hunks).toBe(fileDiff.hunks);
  });

  it('bounds parsed hunk complexity after removing full file text', () => {
    const fileDiff = parseDiffFromFile(
      { name: 'src/example.ts', contents: 'a\nb\nc\n', lang: 'ts' },
      { name: 'src/example.ts', contents: 'a\nchanged\nc\n', lang: 'ts' }
    );
    const complexity = measureParsedFileDiffComplexity(fileDiff);

    expect(complexity.changedLines).toBeGreaterThan(0);
    expect(complexity.hunkLines).toBeGreaterThan(0);
    expect(complexity.hunkTextLength).toBeGreaterThan(0);
    expect(
      boundParsedFileDiffForMainThread(fileDiff, {
        maxChangedLines: complexity.changedLines - 1,
      })
    ).toMatchObject({
      status: 'too-large',
      reason: 'parsed-changed-lines-too-large',
    });
    expect(
      boundParsedFileDiffForMainThread(fileDiff, {
        maxHunkLines: complexity.hunkLines - 1,
      })
    ).toMatchObject({
      status: 'too-large',
      reason: 'parsed-hunk-lines-too-large',
    });
    expect(
      boundParsedFileDiffForMainThread(fileDiff, {
        maxHunkTextLength: complexity.hunkTextLength - 1,
      })
    ).toMatchObject({
      status: 'too-large',
      reason: 'parsed-hunk-text-too-large',
    });

    const bounded = boundParsedFileDiffForMainThread(fileDiff, {
      maxChangedLines: complexity.changedLines,
      maxHunkLines: complexity.hunkLines,
      maxHunkTextLength: complexity.hunkTextLength,
    });
    expect(bounded.status).toBe('ready');
    if (bounded.status === 'ready') {
      expect('oldLines' in bounded.fileDiff).toBe(false);
      expect('newLines' in bounded.fileDiff).toBe(false);
    }
  });
});
