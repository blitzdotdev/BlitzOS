import type { SnapshotCodec } from '@loro-dev/streams-crdt';
import {
  compress as compressSnapshotWithZstd,
  decompress as decompressSnapshotWithZstd,
} from '@loro-dev/streams-crdt/zstd';

const ZSTD_FRAME_MAGIC = [0x28, 0xb5, 0x2f, 0xfd] as const;

const hasZstdFrameMagic = (snapshot: Uint8Array): boolean => {
  return (
    snapshot.byteLength >= ZSTD_FRAME_MAGIC.length &&
    snapshot[0] === ZSTD_FRAME_MAGIC[0] &&
    snapshot[1] === ZSTD_FRAME_MAGIC[1] &&
    snapshot[2] === ZSTD_FRAME_MAGIC[2] &&
    snapshot[3] === ZSTD_FRAME_MAGIC[3]
  );
};

export const compressStreamsSnapshot = async (snapshot: Uint8Array): Promise<Uint8Array> =>
  await compressSnapshotWithZstd(snapshot);

export const decompressStreamsSnapshot = async (snapshot: Uint8Array): Promise<Uint8Array> => {
  // Existing streams may already contain raw snapshots from before zstd rollout.
  if (!hasZstdFrameMagic(snapshot)) {
    return snapshot;
  }
  return await decompressSnapshotWithZstd(snapshot);
};

export const streamsSnapshotCodec: SnapshotCodec = {
  compress: compressStreamsSnapshot,
  decompress: decompressStreamsSnapshot,
};
