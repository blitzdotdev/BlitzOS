import { describe, expect, it } from 'vitest';
import type { SessionFileOpenResult, SessionFileProviderState } from '../src/lib/session-file-provider';
import {
  normalizePinnedProviderOpenResult,
  refreshPinnedProviderFileViewerTab,
} from '../src/lib/session-file-provider-open-result';

const readyCodeCollabProvider = {
  kind: 'code-collab',
  ready: true,
  sourceState: 'live-collaborative',
} satisfies SessionFileProviderState;

describe('normalizePinnedProviderOpenResult', () => {
  it('maps a pinned code-collab fileId miss into a deleted file state', () => {
    expect(
      normalizePinnedProviderOpenResult(
        {
          status: 'unavailable',
          reason: 'metadata-only',
          message: 'File is not indexed by Code Collab metadata',
        },
        {
          fileId: 't:old-file',
          path: 'src/old.ts',
          providerState: readyCodeCollabProvider,
        }
      )
    ).toEqual({
      status: 'unavailable',
      entry: {
        fileId: 't:old-file',
        path: 'src/old.ts',
        kind: 'deleted',
        sourceState: 'degraded',
        readonly: true,
        unavailableReason: 'deleted',
      },
      reason: 'deleted',
      message: 'File was deleted from the collaborative workspace.',
    });
  });

  it('leaves plain path misses and unavailable providers unchanged', () => {
    const pathMiss = {
      status: 'unavailable',
      reason: 'metadata-only',
    } satisfies SessionFileOpenResult;
    expect(
      normalizePinnedProviderOpenResult(pathMiss, {
        path: 'src/missing.ts',
        providerState: readyCodeCollabProvider,
      })
    ).toBe(pathMiss);

    const unavailableProviderMiss = {
      status: 'unavailable',
      reason: 'metadata-only',
      message: 'Conversation files are unavailable',
    } satisfies SessionFileOpenResult;
    expect(
      normalizePinnedProviderOpenResult(unavailableProviderMiss, {
        fileId: 't:old-file',
        path: 'src/old.ts',
        providerState: {
          kind: 'none',
          ready: false,
          sourceState: 'degraded',
          message: 'Conversation files are unavailable',
        },
      })
    ).toBe(unavailableProviderMiss);
  });

  it('keeps provider results that already include an entry unchanged', () => {
    const result = {
      status: 'unavailable',
      entry: {
        fileId: 't:huge',
        path: 'src/huge.ts',
        kind: 'text',
        sourceState: 'degraded',
        unavailableReason: 'text-too-large',
      },
      reason: 'text-too-large',
    } satisfies SessionFileOpenResult;

    expect(
      normalizePinnedProviderOpenResult(result, {
        fileId: 't:huge',
        path: 'src/huge.ts',
        providerState: readyCodeCollabProvider,
      })
    ).toBe(result);
  });

  it('keeps a pinned file tab bound to the old fileId when same-path content is recreated', () => {
    const tab = {
      id: 'file:t:old-file',
      type: 'file' as const,
      filePath: 'src/index.ts',
      fileId: 't:old-file',
      label: 'index.ts',
      focusRequestSeq: 1,
    };

    expect(refreshPinnedProviderFileViewerTab(tab, null)).toBe(tab);
  });

  it('follows provider renames when the pinned fileId is preserved', () => {
    expect(
      refreshPinnedProviderFileViewerTab(
        {
          id: 'file:t:old-file',
          type: 'file',
          filePath: 'src/old.ts',
          fileId: 't:old-file',
          label: 'old.ts',
          startLine: 3,
        },
        {
          fileId: 't:old-file',
          path: 'src/new.ts',
          kind: 'text',
          sourceState: 'live-collaborative',
        }
      )
    ).toEqual({
      id: 'file:t:old-file',
      type: 'file',
      filePath: 'src/new.ts',
      fileId: 't:old-file',
      label: 'new.ts',
      startLine: 3,
    });
  });
});
