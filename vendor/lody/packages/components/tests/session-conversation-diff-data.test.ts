import { describe, expect, it } from 'vitest';
import {
  getDiffDataLoadScheduling,
  isCacheableResolvedFileDiffData,
  shouldRetrySessionProviderDiffErrorMessage,
  shouldStartSessionDiffLoads,
} from '../src/components/sessions/use-session-conversation-diff-data';

describe('shouldStartSessionDiffLoads', () => {
  const loadableInput = {
    useProviderDiff: true,
    waitForProviderDiff: false,
    loadPaused: false,
    fileDiffsPending: false,
    normalizedPathCount: 2,
    mode: 'conversation' as const,
    turnId: 'turn-1',
  };

  it('starts loads once the summary checkpoints are hydrated', () => {
    expect(shouldStartSessionDiffLoads(loadableInput)).toBe(true);
  });

  it('waits for conversation fileDiffs but not All Changes metadata', () => {
    // Regression: firing getDiff before the per-turn checkpoints arrive stores a
    // "requires a session-history fileDiff checkpoint" error for data that is in flight.
    expect(shouldStartSessionDiffLoads({ ...loadableInput, fileDiffsPending: true })).toBe(false);
    // All Changes reads the file-index currentChanges metadata directly; it must not wait for
    // session-history checkpoints.
    expect(
      shouldStartSessionDiffLoads({
        ...loadableInput,
        fileDiffsPending: true,
        mode: 'base',
        turnId: undefined,
      })
    ).toBe(true);
  });

  it('keeps the existing provider, pause, and turn gates', () => {
    expect(shouldStartSessionDiffLoads({ ...loadableInput, useProviderDiff: false })).toBe(false);
    expect(shouldStartSessionDiffLoads({ ...loadableInput, waitForProviderDiff: true })).toBe(
      false
    );
    expect(shouldStartSessionDiffLoads({ ...loadableInput, loadPaused: true })).toBe(false);
    expect(shouldStartSessionDiffLoads({ ...loadableInput, normalizedPathCount: 0 })).toBe(false);
    expect(shouldStartSessionDiffLoads({ ...loadableInput, turnId: undefined })).toBe(false);
    expect(shouldStartSessionDiffLoads({ ...loadableInput, mode: 'base', turnId: undefined })).toBe(
      true
    );
  });
});

describe('shouldRetrySessionProviderDiffErrorMessage', () => {
  it('retries transient provider diff failures', () => {
    expect(
      shouldRetrySessionProviderDiffErrorMessage(
        'turn history doc sync failed: timeout: TIMEOUT: connect request exceeded 10000ms'
      )
    ).toBe(true);
    expect(
      shouldRetrySessionProviderDiffErrorMessage(
        'Code Collab changed files failed with transient IO'
      )
    ).toBe(true);
    expect(
      shouldRetrySessionProviderDiffErrorMessage(
        'Code Collab frontier checkout timed out in the worker.'
      )
    ).toBe(true);
    expect(shouldRetrySessionProviderDiffErrorMessage('Streams RPC client not ready')).toBe(true);
  });

  it('does not retry stable unavailable turn-history results', () => {
    expect(
      shouldRetrySessionProviderDiffErrorMessage(
        'Code Collab did not record diff data for this file in the selected turn.'
      )
    ).toBe(false);
    expect(
      shouldRetrySessionProviderDiffErrorMessage('Code Collab changed files are unavailable')
    ).toBe(false);
  });
});

describe('isCacheableResolvedFileDiffData', () => {
  it('does not cache disposable worker-backed diff sources', () => {
    expect(
      isCacheableResolvedFileDiffData({
        status: 'ready-text-source',
        source: {
          oldTextLength: 10,
          newTextLength: 12,
          readChunk: async () => '',
          dispose: () => {},
        },
      })
    ).toBe(false);
    expect(
      isCacheableResolvedFileDiffData({
        status: 'ready-parsed',
        fileDiff: { hunks: [] },
        oldTextLength: 10,
        newTextLength: 12,
      })
    ).toBe(true);
  });
});

describe('getDiffDataLoadScheduling', () => {
  it('loads small diff lists as a small concurrent batch', () => {
    expect(getDiffDataLoadScheduling(4)).toEqual({
      maxConcurrentLoads: 4,
      maxPendingLoadsPerEffect: 4,
      delayNonPriorityLoads: false,
    });
  });

  it('keeps large diff lists on conservative virtualized loading', () => {
    expect(getDiffDataLoadScheduling(17)).toEqual({
      maxConcurrentLoads: 4,
      maxPendingLoadsPerEffect: 4,
      delayNonPriorityLoads: true,
    });
  });
});
