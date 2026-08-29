import { describe, expect, it } from 'vitest';

import {
  normalizeFileDiff,
  normalizeFileDiffCodeCollabCheckpoint,
  parseSerializedLoroOpId,
  serializeLoroOpId,
} from '../src/schema';

describe('Code Collab fileDiff checkpoints', () => {
  it('serializes and parses single Loro OpIds', () => {
    expect(serializeLoroOpId({ peer: 42, counter: 7 })).toBe('42:7');
    expect(parseSerializedLoroOpId('42:7')).toEqual({ peer: '42', counter: 7 });
    expect(parseSerializedLoroOpId('42')).toBeUndefined();
    expect(parseSerializedLoroOpId('-1:7')).toBeUndefined();
  });

  it('normalizes the lightweight session-history checkpoint shape', () => {
    expect(
      normalizeFileDiffCodeCollabCheckpoint({
        v: 1,
        fileId: 't:123',
        opId: '1:2',
        baseOpId: '1:1',
        base: 'missing',
        deleted: true,
        ignored: 'value',
      })
    ).toEqual({
      v: 1,
      fileId: 't:123',
      opId: '1:2',
      baseOpId: '1:1',
      base: 'missing',
      deleted: true,
    });
    expect(
      normalizeFileDiffCodeCollabCheckpoint({ v: 1, fileId: 't:123', opId: 'bad' })
    ).toBeUndefined();
  });

  it('normalizes fileDiff entries while preserving compact checkpoints', () => {
    expect(
      normalizeFileDiff({
        filePath: 'src/index.ts',
        add: 1,
        del: 2,
        cc: { v: 1, fileId: 't:123', opId: '1:2' },
      })
    ).toEqual({
      filePath: 'src/index.ts',
      add: 1,
      del: 2,
      cc: { v: 1, fileId: 't:123', opId: '1:2' },
    });
    expect(normalizeFileDiff({ filePath: 'src/index.ts' })).toEqual({
      filePath: 'src/index.ts',
      add: 0,
      del: 0,
    });
    expect(normalizeFileDiff({ filePath: '' })).toBeUndefined();
  });
});
