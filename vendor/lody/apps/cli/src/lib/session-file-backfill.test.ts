import { describe, expect, it } from 'vitest';
import type { SessionHistoryInput } from '@lody/shared';

import {
  SESSION_FILE_BACKFILL_BASE_DELAY_MS,
  SESSION_FILE_BACKFILL_MAX_DELAY_MS,
  flipFileTransportToR2,
  sessionFileBackfillDelayMs,
} from './session-file-backfill';

const fileItem = (over: Record<string, unknown>) => ({
  type: 'file' as const,
  fileId: 'file-1',
  fileName: 'n.txt',
  mimeType: 'text/plain',
  sizeBytes: 5,
  sha256: 'a'.repeat(64),
  textPreview: true,
  transport: 'local' as const,
  machineId: 'machine-1',
  uploadedAt: 1,
  ...over,
});

const history = (items: unknown[]): SessionHistoryInput[] => [
  {
    id: 'h1',
    role: 'user',
    items: items as SessionHistoryInput['items'],
    timestamp: '2026-01-01T00:00:00.000Z',
    fileDiff: [],
    finished: true,
  },
];

describe('sessionFileBackfillDelayMs', () => {
  it('grows exponentially from the base and caps at the max', () => {
    expect(sessionFileBackfillDelayMs(1)).toBe(SESSION_FILE_BACKFILL_BASE_DELAY_MS);
    expect(sessionFileBackfillDelayMs(2)).toBe(SESSION_FILE_BACKFILL_BASE_DELAY_MS * 2);
    expect(sessionFileBackfillDelayMs(3)).toBe(SESSION_FILE_BACKFILL_BASE_DELAY_MS * 4);
    expect(sessionFileBackfillDelayMs(100)).toBe(SESSION_FILE_BACKFILL_MAX_DELAY_MS);
  });
});

describe('flipFileTransportToR2', () => {
  it('flips transport, drops machineId, and adopts the relay fileId', () => {
    const h = history([fileItem({ fileId: 'local-1', machineId: 'm1' })]);
    const next = flipFileTransportToR2(h, 'local-1', 'relay-99');
    expect(next).not.toBeNull();
    const item = next![0]!.items![0] as Record<string, unknown>;
    expect(item.transport).toBe('r2');
    expect(item.machineId).toBeUndefined();
    expect(item.fileId).toBe('relay-99');
    // Untouched fields survive.
    expect(item.sha256).toBe('a'.repeat(64));
    expect(item.fileName).toBe('n.txt');
  });

  it('leaves sibling items and other turns untouched', () => {
    const sibling = { type: 'text', text: 'keep me' };
    const h = history([sibling, fileItem({ fileId: 'local-1' })]);
    const next = flipFileTransportToR2(h, 'local-1', 'relay-1')!;
    expect(next[0]!.items![0]).toEqual(sibling);
  });

  it('returns null when no matching local-transport item exists', () => {
    expect(
      flipFileTransportToR2(history([fileItem({ transport: 'r2' })]), 'file-1', 'r')
    ).toBeNull();
    expect(
      flipFileTransportToR2(history([{ type: 'text', text: 'x' }]), 'missing', 'r')
    ).toBeNull();
  });
});
