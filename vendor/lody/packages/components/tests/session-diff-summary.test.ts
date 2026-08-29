import { describe, expect, test } from 'vitest';

import {
  areSessionDiffSummariesEqual,
  buildSessionDiffSummary,
  buildSessionDiffSummaryFromProviderChanges,
} from '../src/components/sessions/session-diff-summary';

describe('buildSessionDiffSummary', () => {
  test('deduplicates per-turn file paths without synthesizing All Changes entries', () => {
    const summary = buildSessionDiffSummary([
      {
        id: 'turn-1',
        fileDiff: [
          { filePath: 'src/a.ts', add: 2, del: 1 },
          { filePath: 'src/b.ts', add: 4, del: 0 },
          { filePath: 'src/a.ts', add: 1, del: 3 },
        ],
      },
      {
        id: 'turn-2',
        fileDiff: [{ filePath: 'src/a.ts', add: 5, del: 2 }],
      },
    ]);

    expect(summary.changeEntries).toEqual([]);
    expect(summary.changeFilePaths).toEqual([]);
    expect(summary.diffFilePathsByTurn).toEqual({
      'turn-1': ['src/a.ts', 'src/b.ts'],
      'turn-2': ['src/a.ts'],
    });
    expect(summary.diffEntriesByTurn).toEqual({
      'turn-1': [
        { filePath: 'src/a.ts', add: 3, del: 4 },
        { filePath: 'src/b.ts', add: 4, del: 0 },
      ],
      'turn-2': [{ filePath: 'src/a.ts', add: 5, del: 2 }],
    });
  });

  test('treats non-diff conversation updates as unchanged', () => {
    const baseSummary = buildSessionDiffSummary([
      {
        id: 'turn-1',
        fileDiff: [{ filePath: 'src/a.ts', add: 2, del: 1 }],
      },
    ]);

    const updatedSummary = buildSessionDiffSummary([
      {
        id: 'turn-1',
        fileDiff: [{ filePath: 'src/a.ts', add: 2, del: 1 }],
      },
      {
        id: 'turn-2',
      },
      {
        id: 'turn-3',
        fileDiff: [],
      },
    ]);

    expect(areSessionDiffSummariesEqual(baseSummary, updatedSummary)).toBe(true);
  });

  test('detects per-turn diff updates', () => {
    const baseSummary = buildSessionDiffSummary([
      {
        id: 'turn-1',
        fileDiff: [{ filePath: 'src/a.ts', add: 2, del: 1 }],
      },
    ]);

    const updatedSummary = buildSessionDiffSummary([
      {
        id: 'turn-1',
        fileDiff: [{ filePath: 'src/a.ts', add: 2, del: 1 }],
      },
      {
        id: 'turn-2',
        fileDiff: [{ filePath: 'src/a.ts', add: 1, del: 0 }],
      },
    ]);

    expect(areSessionDiffSummariesEqual(baseSummary, updatedSummary)).toBe(false);
  });

  test('does not synthesize All Changes entries when history is empty', () => {
    const summary = buildSessionDiffSummary(undefined);

    expect(summary.changeEntries).toEqual([]);
    expect(summary.changeFilePaths).toEqual([]);
    expect(summary.diffFilePathsByTurn).toEqual({});
  });

  test('builds summaries from provider changed-file entries', () => {
    const summary = buildSessionDiffSummaryFromProviderChanges(
      [
        {
          fileId: 't:a',
          path: 'src/a.ts',
          kind: 'text',
          sourceState: 'live-collaborative',
          add: 2,
          del: 1,
        },
        {
          fileId: 't:a',
          path: 'src/a.ts',
          kind: 'text',
          sourceState: 'live-collaborative',
          add: 3,
        },
      ],
      {
        'turn-1': [
          {
            fileId: 't:b',
            path: 'src/b.ts',
            kind: 'text',
            sourceState: 'historical-turn',
            add: 100,
            del: 50,
          },
          {
            fileId: 't:a',
            path: 'src/a.ts',
            kind: 'text',
            sourceState: 'historical-turn',
          },
          {
            fileId: 't:c',
            path: 'src/c.ts',
            kind: 'text',
            sourceState: 'historical-turn',
          },
        ],
      }
    );

    expect(summary.changeEntries).toEqual([{ filePath: 'src/a.ts', add: 5, del: 1 }]);
    expect(summary.changeFilePaths).toEqual(['src/a.ts']);
    expect(summary.diffFilePathsByTurn).toEqual({
      'turn-1': ['src/a.ts', 'src/b.ts', 'src/c.ts'],
    });
    expect(summary.diffEntriesByTurn).toEqual({
      'turn-1': [
        { filePath: 'src/a.ts', add: undefined, del: undefined },
        { filePath: 'src/b.ts', add: 100, del: 50 },
        { filePath: 'src/c.ts', add: undefined, del: undefined },
      ],
    });
  });

  test('keeps provider stats unavailable when provider entries do not include line stats', () => {
    const summary = buildSessionDiffSummaryFromProviderChanges(
      [
        {
          fileId: 't:a',
          path: 'src/a.ts',
          kind: 'text',
          sourceState: 'live-collaborative',
        },
      ],
      {
        'turn-1': [
          {
            fileId: 't:a',
            path: 'src/a.ts',
            kind: 'text',
            sourceState: 'historical-turn',
          },
        ],
      }
    );

    expect(summary.changeEntries).toEqual([
      { filePath: 'src/a.ts', add: undefined, del: undefined },
    ]);
    expect(summary.changeFilePaths).toEqual(['src/a.ts']);
    expect(summary.diffFilePathsByTurn).toEqual({ 'turn-1': ['src/a.ts'] });
    expect(summary.diffEntriesByTurn).toEqual({
      'turn-1': [{ filePath: 'src/a.ts', add: undefined, del: undefined }],
    });
  });

  test('uses provider line stats for All Changes entries', () => {
    const summary = buildSessionDiffSummaryFromProviderChanges(
      [
        {
          fileId: 't:a',
          path: 'src/a.ts',
          kind: 'text',
          sourceState: 'live-collaborative',
          add: 2,
          del: 1,
        },
        {
          fileId: 't:a',
          path: 'src/a.ts',
          kind: 'text',
          sourceState: 'live-collaborative',
          add: 3,
          del: 4,
        },
      ],
      null
    );

    expect(summary.changeEntries).toEqual([{ filePath: 'src/a.ts', add: 5, del: 5 }]);
  });

  test('keeps provider 0/0 stats without session-level fallback', () => {
    const summary = buildSessionDiffSummaryFromProviderChanges(
      [
        {
          fileId: 't:a',
          path: 'README.md',
          kind: 'text',
          sourceState: 'live-collaborative',
          add: 0,
          del: 0,
        },
      ],
      {
        'turn-1': [
          {
            fileId: 't:a',
            path: 'README.md',
            kind: 'text',
            sourceState: 'historical-turn',
            add: 0,
            del: 0,
          },
        ],
      }
    );

    expect(summary.changeEntries).toEqual([{ filePath: 'README.md', add: 0, del: 0 }]);
    expect(summary.diffEntriesByTurn).toEqual({
      'turn-1': [{ filePath: 'README.md', add: 0, del: 0 }],
    });
  });

  test('keeps provider 0/0 stats across multiple turns', () => {
    const summary = buildSessionDiffSummaryFromProviderChanges(
      [],
      {
        'turn-1': [
          {
            fileId: 't:a',
            path: 'README.md',
            kind: 'text',
            sourceState: 'historical-turn',
            add: 0,
            del: 0,
          },
        ],
        'turn-2': [
          {
            fileId: 't:a',
            path: 'README.md',
            kind: 'text',
            sourceState: 'historical-turn',
            add: 0,
            del: 0,
          },
        ],
      }
    );

    expect(summary.diffEntriesByTurn).toEqual({
      'turn-1': [{ filePath: 'README.md', add: 0, del: 0 }],
      'turn-2': [{ filePath: 'README.md', add: 0, del: 0 }],
    });
  });

  test('keeps provider stats unavailable when provider lacks line stats', () => {
    const summary = buildSessionDiffSummaryFromProviderChanges(
      [
        {
          fileId: 't:a',
          path: 'src/a.ts',
          kind: 'text',
          sourceState: 'live-collaborative',
        },
      ],
      null
    );

    expect(summary.changeEntries).toEqual([
      { filePath: 'src/a.ts', add: undefined, del: undefined },
    ]);
  });

  test('does not synthesize provider change paths from absent provider changes', () => {
    const summary = buildSessionDiffSummaryFromProviderChanges([], null);

    expect(summary.changeEntries).toEqual([]);
    expect(summary.changeFilePaths).toEqual([]);
    expect(summary.diffFilePathsByTurn).toEqual({});
  });
});
