import { describe, expect, it } from 'vitest';
import { sessionFileOpenResultToContentLoadResult } from '../src/lib/session-file-content-snapshot';

describe('sessionFileOpenResultToContentLoadResult', () => {
  it('maps provider text snapshots into viewer text snapshots', () => {
    expect(
      sessionFileOpenResultToContentLoadResult({
        status: 'ready',
        entry: {
          path: 'src/main.ts',
          kind: 'text',
          sourceState: 'live-collaborative',
        },
        snapshot: {
          kind: 'text',
          text: 'export const value = 1;',
        },
      })
    ).toEqual({
      status: 'ready',
      snapshot: {
        kind: 'text',
        text: 'export const value = 1;',
      },
    });
  });

  it('preserves provider binary bytes so the viewer can preview images', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(
      sessionFileOpenResultToContentLoadResult({
        status: 'ready',
        entry: {
          path: 'public/logo.png',
          kind: 'binary',
          sourceState: 'live-readonly',
        },
        snapshot: {
          kind: 'binary',
          bytes,
        },
      })
    ).toEqual({
      status: 'ready',
      snapshot: {
        kind: 'binary',
        bytes,
      },
    });
  });

  it('maps binary snapshots without bytes into a bytes-less viewer state', () => {
    expect(
      sessionFileOpenResultToContentLoadResult({
        status: 'ready',
        entry: {
          path: 'public/logo.png',
          kind: 'binary',
          sourceState: 'live-readonly',
        },
        snapshot: {
          kind: 'binary',
        },
      })
    ).toEqual({
      status: 'ready',
      snapshot: {
        kind: 'binary',
      },
    });
  });

  it('preserves provider unavailable messages for the viewer', () => {
    expect(
      sessionFileOpenResultToContentLoadResult({
        status: 'unavailable',
        reason: 'text-too-large',
        message: 'Text file is too large for realtime collaboration.',
      })
    ).toEqual({
      status: 'error',
      message: 'Text file is too large for realtime collaboration.',
      reason: 'text-too-large',
    });
  });

  it('maps provider unavailable reasons into readable default messages', () => {
    expect(
      sessionFileOpenResultToContentLoadResult({
        status: 'unavailable',
        reason: 'text-too-large',
      })
    ).toEqual({
      status: 'error',
      message: 'Text too large',
      reason: 'text-too-large',
    });

    expect(
      sessionFileOpenResultToContentLoadResult({
        status: 'ready',
        entry: {
          path: 'src/generated.ts',
          kind: 'text',
          sourceState: 'degraded',
        },
        snapshot: {
          kind: 'unavailable',
          reason: 'unsupported-encoding',
        },
      })
    ).toEqual({
      status: 'error',
      message: 'Unsupported encoding',
      reason: 'unsupported-encoding',
    });
  });
});
