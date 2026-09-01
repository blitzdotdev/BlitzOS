import { describe, expect, test } from 'vitest';

import {
  buildProviderDiffSummaryFromChangedFileResults,
  computeSessionDiffInputsFingerprint,
  collectReadyProviderChangedFilesByTurn,
  selectProviderDiffTurnIds,
  shouldRetryProviderDiffSummaryMessage,
} from '../src/components/sessions/use-session-diff-summary';

describe('useSessionDiffSummary helpers', () => {
  test('ignores streaming history item changes when fingerprinting diff inputs', () => {
    const before = computeSessionDiffInputsFingerprint([
      {
        id: 'assistant-1',
        role: 'assistant',
        items: [{ type: 'text', text: 'hello' }],
        fileDiff: [],
      },
    ]);
    const after = computeSessionDiffInputsFingerprint([
      {
        id: 'assistant-1',
        role: 'assistant',
        items: [{ type: 'text', text: 'hello world streamed token' }],
        fileDiff: [],
      },
    ]);

    expect(after).toBe(before);
  });

  test('tracks fileDiff checkpoints when fingerprinting diff inputs', () => {
    const before = computeSessionDiffInputsFingerprint([
      {
        id: 'assistant-1',
        role: 'assistant',
        fileDiff: [{ filePath: 'README.md', add: 1, del: 0 }],
      },
    ]);
    const after = computeSessionDiffInputsFingerprint([
      {
        id: 'assistant-1',
        role: 'assistant',
        fileDiff: [
          {
            filePath: 'README.md',
            add: 1,
            del: 0,
            cc: { v: 1, fileId: 't:readme', baseOpId: '1:1', opId: '1:2' },
          },
        ],
      },
    ]);

    expect(after).not.toBe(before);
  });

  test('selects assistant turns for provider per-turn diff reads', () => {
    expect(
      selectProviderDiffTurnIds([
        { id: 'user-1', role: 'user' },
        { id: 'assistant-1', role: 'assistant' },
        { id: 'system-1', role: 'system' },
        { id: 'legacy-1' },
      ])
    ).toEqual(['assistant-1', 'legacy-1']);
  });

  test('keeps ready per-turn provider changes when another turn is unavailable', () => {
    expect(
      collectReadyProviderChangedFilesByTurn([
        [
          'assistant-no-marker',
          {
            status: 'unavailable',
            reason: 'metadata-only',
            message: 'Code Collab turn markers were not found: assistant-no-marker',
          },
        ],
        [
          'assistant-edit',
          {
            status: 'ready',
            files: [
              {
                fileId: 't:readme',
                path: 'README.md',
                kind: 'text',
                sourceState: 'historical-turn',
                add: 1,
                del: 1,
              },
            ],
          },
        ],
      ])
    ).toEqual({
      'assistant-edit': [
        {
          fileId: 't:readme',
          path: 'README.md',
          kind: 'text',
          sourceState: 'historical-turn',
          add: 1,
          del: 1,
        },
      ],
    });
  });

  test('keeps all-changes unavailable when only per-turn changes are readable', () => {
    const result = buildProviderDiffSummaryFromChangedFileResults(
      {
        status: 'unavailable',
        reason: 'metadata-only',
        message: 'turn history doc sync failed: timeout: TIMEOUT: connect request exceeded 10000ms',
      },
      [
        [
          'assistant-edit',
          {
            status: 'ready',
            files: [
              {
                fileId: 't:readme',
                path: 'README.md',
                kind: 'text',
                sourceState: 'historical-turn',
              },
            ],
          },
        ],
      ],
    );

    expect(result).toEqual({
      summary: {
        changeEntries: [],
        changeFilePaths: [],
        diffFilePathsByTurn: { 'assistant-edit': ['README.md'] },
        diffEntriesByTurn: {
          'assistant-edit': [{ filePath: 'README.md', add: undefined, del: undefined }],
        },
        fileDiffsByTurn: {},
      },
      unavailableMessage:
        'turn history doc sync failed: timeout: TIMEOUT: connect request exceeded 10000ms',
    });
  });

  test('keeps the unavailable message when no provider turn changes were readable', () => {
    expect(
      buildProviderDiffSummaryFromChangedFileResults(
        {
          status: 'unavailable',
          reason: 'metadata-only',
          message: 'Code Collab changed files are unavailable',
        },
        []
      )
    ).toEqual({
      summary: {
        changeEntries: [],
        changeFilePaths: [],
        diffFilePathsByTurn: {},
        diffEntriesByTurn: {},
        fileDiffsByTurn: {},
      },
      unavailableMessage: 'Code Collab changed files are unavailable',
    });
  });

  test('retries transient provider summary failures only', () => {
    expect(
      shouldRetryProviderDiffSummaryMessage(
        'turn history doc sync failed: timeout: TIMEOUT: connect request exceeded 10000ms'
      )
    ).toBe(true);
    expect(shouldRetryProviderDiffSummaryMessage('fetch failed')).toBe(true);
    expect(shouldRetryProviderDiffSummaryMessage('Code Collab changed files are unavailable')).toBe(
      false
    );
  });
});
