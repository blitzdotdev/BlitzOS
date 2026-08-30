import { describe, expect, it } from 'vitest';

import {
  compressStreamsSnapshot,
  decompressStreamsSnapshot,
  streamsSnapshotCodec,
} from '../src';

describe('streams snapshot codec', () => {
  it('round trips zstd-compressed snapshots', async () => {
    const snapshot = new TextEncoder().encode('hello snapshot');

    const compressed = await compressStreamsSnapshot(snapshot);
    const decompressed = await decompressStreamsSnapshot(compressed);

    expect(Array.from(compressed)).not.toEqual(Array.from(snapshot));
    expect(Array.from(decompressed)).toEqual(Array.from(snapshot));
  });

  it('keeps legacy uncompressed snapshots readable', async () => {
    const snapshot = new Uint8Array([1, 2, 3, 4, 5]);

    const decompressed = await decompressStreamsSnapshot(snapshot);

    expect(decompressed).toBe(snapshot);
  });

  it('exports a codec object that matches the helper functions', async () => {
    const snapshot = new TextEncoder().encode('codec object');

    const compressed = await streamsSnapshotCodec.compress(snapshot);
    const decompressed = await streamsSnapshotCodec.decompress(compressed);

    expect(Array.from(decompressed)).toEqual(Array.from(snapshot));
  });
});
