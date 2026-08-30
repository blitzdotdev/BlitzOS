import * as zlib from 'node:zlib';

import type { TurnDiffCompression } from './types';

export const CODEC_RAW = 0;
export const CODEC_ZSTD = 1;
export const CODEC_GZIP = 2;

const COMPRESSION_LEVEL = 1;
const COMPRESSION_MIN_BYTES = 8 * 1024;
const COMPRESSION_MIN_SAVINGS_BYTES = 64;

const zstdCompressSync = (
  zlib as typeof zlib & {
    readonly zstdCompressSync?: (
      input: Uint8Array,
      options?: { readonly params?: Readonly<Record<number, number>> }
    ) => Buffer;
  }
).zstdCompressSync;
const zstdDecompressSync = (
  zlib as typeof zlib & {
    readonly zstdDecompressSync?: (input: Uint8Array) => Buffer;
  }
).zstdDecompressSync;
const zstdCompressionLevelParameter = (
  zlib.constants as typeof zlib.constants & {
    readonly ZSTD_c_compressionLevel?: number;
  }
).ZSTD_c_compressionLevel;

export interface EncodedChunkPayload {
  readonly codec: number;
  readonly payload: Buffer;
}

export function compressChunk(
  bytes: Uint8Array,
  preference: TurnDiffCompression
): EncodedChunkPayload {
  const raw = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < COMPRESSION_MIN_BYTES) {
    return { codec: CODEC_RAW, payload: raw };
  }

  let codec: number;
  let compressed: Buffer;
  if (
    preference === 'zstd' &&
    zstdCompressSync !== undefined &&
    zstdCompressionLevelParameter !== undefined
  ) {
    compressed = zstdCompressSync(bytes, {
      params: { [zstdCompressionLevelParameter]: COMPRESSION_LEVEL },
    });
    codec = CODEC_ZSTD;
  } else {
    compressed = zlib.gzipSync(bytes, { level: COMPRESSION_LEVEL });
    codec = CODEC_GZIP;
  }

  return compressed.byteLength + COMPRESSION_MIN_SAVINGS_BYTES < raw.byteLength
    ? { codec, payload: compressed }
    : { codec: CODEC_RAW, payload: raw };
}

export function decompressChunk(codec: number, payload: Uint8Array): Buffer {
  if (codec === CODEC_RAW) {
    return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  }
  if (codec === CODEC_ZSTD) {
    if (zstdDecompressSync === undefined) {
      throw new Error('This Node.js runtime cannot decompress a stored zstd turn-diff chunk.');
    }
    return zstdDecompressSync(payload);
  }
  if (codec === CODEC_GZIP) {
    return zlib.gunzipSync(payload);
  }
  throw new Error(`Unknown turn-diff chunk codec ${codec}.`);
}
