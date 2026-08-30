import { describe, expect, it } from 'vitest';
import { CodeCollabContentUnavailableReasonSchema } from '@lody/shared';
import {
  getSessionFileEntryModel,
  getSessionFileOpenResultModel,
  getSessionFileProviderStateModel,
  getSessionFileUnavailableReasonLabel,
  getSessionFileUnavailableRepairHint,
} from '../src/lib/session-file-provider-view-model';

describe('session file provider view model', () => {
  it('maps provider state into concise UI labels and tones', () => {
    expect(
      getSessionFileProviderStateModel({
        kind: 'code-collab',
        ready: true,
        sourceState: 'live-collaborative',
      })
    ).toEqual({
      title: 'Code Collab',
      tone: 'positive',
      message: 'Live',
    });

    expect(
      getSessionFileProviderStateModel({
        kind: 'code-collab',
        ready: false,
        sourceState: 'degraded',
        message: 'Token expired',
      })
    ).toEqual({
      title: 'Code Collab',
      tone: 'muted',
      message: 'Token expired',
    });
  });

  it('maps file entries into open/edit affordances without leaking provider details', () => {
    expect(
      getSessionFileEntryModel({
        fileId: 't:123e4567-e89b-12d3-a456-426614174001',
        path: 'src/index.ts',
        kind: 'text',
        sourceState: 'live-collaborative',
        sizeBytes: 1536,
        textEol: 'crlf',
        hasBom: true,
      })
    ).toMatchObject({
      title: 'src/index.ts',
      detail: 'Text · Live · 1.5 KB · CRLF · BOM',
      kindLabel: 'Text',
      sourceLabel: 'Live',
      canOpen: true,
      canEdit: true,
      tone: 'positive',
    });

    expect(
      getSessionFileEntryModel({
        path: 'assets/video.mov',
        kind: 'large',
        sourceState: 'live-readonly',
        readonly: true,
        unavailableReason: 'blob-too-large',
      })
    ).toMatchObject({
      canOpen: false,
      canEdit: false,
      unavailableLabel: 'Blob too large',
      tone: 'muted',
    });

    expect(
      getSessionFileEntryModel({
        path: 'tmp/dev.sock',
        kind: 'special',
        specialKind: 'socket',
        sourceState: 'degraded',
        unavailableReason: 'unsupported-special',
      })
    ).toMatchObject({
      detail: 'Socket · Limited',
      kindLabel: 'Special',
      canOpen: false,
      canEdit: false,
    });

    expect(
      getSessionFileEntryModel({
        path: 'scripts/build.sh',
        kind: 'text',
        sourceState: 'live-collaborative',
        executable: true,
      })
    ).toMatchObject({
      detail: 'Text · Live · Executable',
    });
  });

  it('maps open results into user-facing messages', () => {
    expect(
      getSessionFileOpenResultModel({
        status: 'unavailable',
        reason: 'missing-text-frontiers',
        message: 'Turn history has no text checkpoint',
      })
    ).toEqual({
      title: 'File unavailable',
      tone: 'muted',
      message: 'Turn history has no text checkpoint',
      repairHint: 'Ask the host to republish text history for this turn.',
    });

    expect(
      getSessionFileOpenResultModel({
        status: 'ready',
        entry: {
          path: 'README.md',
          kind: 'text',
          sourceState: 'historical-turn',
        },
        snapshot: { kind: 'text', text: 'hello' },
      })
    ).toEqual({
      title: 'README.md',
      tone: 'positive',
    });
  });

  it('maps host-offline, permission, missing-content, and readonly states', () => {
    expect(
      getSessionFileProviderStateModel({
        kind: 'code-collab',
        ready: true,
        sourceState: 'host-offline',
      })
    ).toEqual({
      title: 'Code Collab',
      tone: 'warning',
      message: 'Host offline',
    });

    expect(
      getSessionFileEntryModel({
        path: 'src/cached.ts',
        kind: 'text',
        sourceState: 'host-offline',
        readonly: true,
      })
    ).toMatchObject({
      detail: 'Text · Host offline',
      sourceLabel: 'Host offline',
      canOpen: true,
      canEdit: false,
      tone: 'warning',
    });

    expect(
      getSessionFileEntryModel({
        path: 'private.env',
        kind: 'text',
        sourceState: 'degraded',
        readonly: true,
        unavailableReason: 'permission-denied',
      })
    ).toMatchObject({
      unavailableLabel: 'Permission denied',
      canOpen: false,
      canEdit: false,
      tone: 'warning',
    });

    expect(
      getSessionFileOpenResultModel({
        status: 'unavailable',
        reason: 'missing-text-frontiers',
      })
    ).toEqual({
      title: 'File unavailable',
      tone: 'muted',
      message: 'Text history missing',
      repairHint: 'Ask the host to republish text history for this turn.',
    });
  });

  it('maps unavailable reasons into concise labels', () => {
    expect(getSessionFileUnavailableReasonLabel('text-too-large')).toBe('Text too large');
    expect(getSessionFileUnavailableReasonLabel('line-too-long')).toBe('Line too long');
    expect(getSessionFileUnavailableReasonLabel('unsupported-encoding')).toBe(
      'Unsupported encoding'
    );
    expect(getSessionFileUnavailableReasonLabel('unsupported-special')).toBe('Unsupported file');
    expect(getSessionFileUnavailableReasonLabel('blob-expired')).toBe('Blob expired');
    expect(getSessionFileUnavailableReasonLabel('path-collision')).toBe('Path collision');
  });

  it('keeps every unavailable reason mapped to stable UI copy and action state', () => {
    for (const reason of CodeCollabContentUnavailableReasonSchema.options) {
      const label = getSessionFileUnavailableReasonLabel(reason);
      const repairHint = getSessionFileUnavailableRepairHint(reason);
      const entryModel = getSessionFileEntryModel({
        path: `fixtures/${reason}.txt`,
        kind: reason === 'blob-too-large' || reason === 'missing-blob-digest' ? 'binary' : 'text',
        sourceState: 'degraded',
        readonly: true,
        unavailableReason: reason,
      });

      expect(label).not.toBe('');
      expect(label).not.toBe(reason);
      expect(repairHint).not.toBe('');
      expect(entryModel.unavailableLabel).toBe(label);
      expect(entryModel.openDisabledReason).toBe(label);
      expect(entryModel.editDisabledReason).toBe(label);
      expect(entryModel.repairHint).toBe(repairHint);
    }
  });

  it('maps disabled reasons and repair hints for provider UI actions', () => {
    expect(
      getSessionFileEntryModel({
        path: 'src/huge.ts',
        kind: 'large',
        sourceState: 'degraded',
        readonly: true,
        unavailableReason: 'text-too-large',
      })
    ).toMatchObject({
      canOpen: false,
      canEdit: false,
      openDisabledReason: 'Text too large',
      editDisabledReason: 'Text too large',
      repairHint: 'Open this file outside realtime collaboration.',
    });

    expect(
      getSessionFileEntryModel({
        path: 'assets/logo.png',
        kind: 'binary',
        sourceState: 'live-readonly',
        readonly: true,
      })
    ).toMatchObject({
      canOpen: true,
      canEdit: false,
      editDisabledReason: 'Only text files can be edited',
    });

    expect(getSessionFileUnavailableRepairHint('path-collision')).toBe(
      'Rename one of the colliding paths on a case-insensitive file system.'
    );
  });
});
