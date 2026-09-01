import { createHash } from 'node:crypto';

export const FASTCDC_PROFILE_ID = 'fastcdc-v2020-n1-s0-8k-32k-128k';

const MASK_HEX = [
  '0',
  '0',
  '0',
  '0',
  '0',
  '0000000001804110',
  '0000000001803110',
  '0000000018035100',
  '0000001800035300',
  '0000019000353000',
  '0000590003530000',
  '0000d90003530000',
  '0000d90103530000',
  '0000d90303530000',
  '0000d90313530000',
  '0000d90f03530000',
  '0000d90303537000',
  '0000d90703537000',
  '0000d90707537000',
  '0000d91707537000',
  '0000d91747537000',
  '0000d91767537000',
  '0000d93767537000',
  '0000d93777537000',
  '0000d93777577000',
  '0000db3777577000',
] as const;

const UINT32_BASE = 0x1_0000_0000;

interface U64Pair {
  readonly hi: number;
  readonly lo: number;
}

interface FastCdcConfig {
  readonly minSize: number;
  readonly avgSize: number;
  readonly maxSize: number;
  readonly maskSHi: number;
  readonly maskSLo: number;
  readonly maskLHi: number;
  readonly maskLLo: number;
  readonly maskSLsHi: number;
  readonly maskSLsLo: number;
  readonly maskLLsHi: number;
  readonly maskLLsLo: number;
}

export interface FastCdcChunk {
  readonly offset: number;
  readonly length: number;
}

function splitHex64(value: string): U64Pair {
  const padded = value.padStart(16, '0');
  return {
    hi: Number.parseInt(padded.slice(0, 8), 16) >>> 0,
    lo: Number.parseInt(padded.slice(8), 16) >>> 0,
  };
}

function shiftLeftOne(hi: number, lo: number): U64Pair {
  return {
    hi: ((hi << 1) | (lo >>> 31)) >>> 0,
    lo: (lo << 1) >>> 0,
  };
}

function generateTables(): {
  readonly gearHi: Uint32Array;
  readonly gearLo: Uint32Array;
  readonly gearLsHi: Uint32Array;
  readonly gearLsLo: Uint32Array;
} {
  const gearHi = new Uint32Array(256);
  const gearLo = new Uint32Array(256);
  const gearLsHi = new Uint32Array(256);
  const gearLsLo = new Uint32Array(256);

  // This is the table64 procedure from fastcdc-rs: MD5 of 64 bytes filled
  // with the byte value, interpreted as a big-endian u64 from digest[0..8].
  for (let index = 0; index < 256; index += 1) {
    const digest = createHash('md5').update(Buffer.alloc(64, index)).digest();
    const hi = digest.readUInt32BE(0);
    const lo = digest.readUInt32BE(4);
    const shifted = shiftLeftOne(hi, lo);
    gearHi[index] = hi;
    gearLo[index] = lo;
    gearLsHi[index] = shifted.hi;
    gearLsLo[index] = shifted.lo;
  }

  return { gearHi, gearLo, gearLsHi, gearLsLo };
}

const TABLES = generateTables();

function createConfig(
  minSize: number,
  avgSize: number,
  maxSize: number,
  normalization = 1
): FastCdcConfig {
  if ((avgSize & (avgSize - 1)) !== 0) {
    throw new Error('FastCDC average size must be a power of two.');
  }
  const bits = 31 - Math.clz32(avgSize);
  const maskSHex = MASK_HEX[bits + normalization];
  const maskLHex = MASK_HEX[bits - normalization];
  if (maskSHex === undefined || maskLHex === undefined) {
    throw new Error(`FastCDC mask is unavailable for average size ${avgSize}.`);
  }
  const maskS = splitHex64(maskSHex);
  const maskL = splitHex64(maskLHex);
  const maskSLs = shiftLeftOne(maskS.hi, maskS.lo);
  const maskLLs = shiftLeftOne(maskL.hi, maskL.lo);
  return {
    minSize,
    avgSize,
    maxSize,
    maskSHi: maskS.hi,
    maskSLo: maskS.lo,
    maskLHi: maskL.hi,
    maskLLo: maskL.lo,
    maskSLsHi: maskSLs.hi,
    maskSLsLo: maskSLs.lo,
    maskLLsHi: maskLLs.hi,
    maskLLsLo: maskLLs.lo,
  };
}

const DEFAULT_CONFIG = createConfig(8 * 1024, 32 * 1024, 128 * 1024, 1);

function cutLength(
  bytes: Uint8Array,
  start: number,
  available: number,
  config: FastCdcConfig
): number {
  let remaining = available;
  if (remaining <= config.minSize) {
    return remaining;
  }

  let center = config.avgSize;
  if (remaining > config.maxSize) {
    remaining = config.maxSize;
  } else if (remaining < center) {
    center = remaining;
  }

  let index = config.minSize >>> 1;
  let hi = 0;
  let lo = 0;
  const centerHalf = center >>> 1;
  const remainingHalf = remaining >>> 1;
  const { gearHi, gearLo, gearLsHi, gearLsLo } = TABLES;

  while (index < centerHalf) {
    const relativeOffset = index << 1;
    const first = bytes[start + relativeOffset] as number;
    const shiftedHi = ((hi << 2) | (lo >>> 30)) >>> 0;
    const shiftedLo = (lo << 2) >>> 0;
    const lowSum = shiftedLo + (gearLsLo[first] as number);
    lo = lowSum >>> 0;
    hi = (shiftedHi + (gearLsHi[first] as number) + (lowSum >= UINT32_BASE ? 1 : 0)) >>> 0;
    if ((hi & config.maskSLsHi) === 0 && (lo & config.maskSLsLo) === 0) {
      return relativeOffset;
    }

    const second = bytes[start + relativeOffset + 1] as number;
    const secondLowSum = lo + (gearLo[second] as number);
    lo = secondLowSum >>> 0;
    hi = (hi + (gearHi[second] as number) + (secondLowSum >= UINT32_BASE ? 1 : 0)) >>> 0;
    if ((hi & config.maskSHi) === 0 && (lo & config.maskSLo) === 0) {
      return relativeOffset + 1;
    }
    index += 1;
  }

  while (index < remainingHalf) {
    const relativeOffset = index << 1;
    const first = bytes[start + relativeOffset] as number;
    const shiftedHi = ((hi << 2) | (lo >>> 30)) >>> 0;
    const shiftedLo = (lo << 2) >>> 0;
    const lowSum = shiftedLo + (gearLsLo[first] as number);
    lo = lowSum >>> 0;
    hi = (shiftedHi + (gearLsHi[first] as number) + (lowSum >= UINT32_BASE ? 1 : 0)) >>> 0;
    if ((hi & config.maskLLsHi) === 0 && (lo & config.maskLLsLo) === 0) {
      return relativeOffset;
    }

    const second = bytes[start + relativeOffset + 1] as number;
    const secondLowSum = lo + (gearLo[second] as number);
    lo = secondLowSum >>> 0;
    hi = (hi + (gearHi[second] as number) + (secondLowSum >= UINT32_BASE ? 1 : 0)) >>> 0;
    if ((hi & config.maskLHi) === 0 && (lo & config.maskLLo) === 0) {
      return relativeOffset + 1;
    }
    index += 1;
  }

  return remaining;
}

export function fastCdcV2020(bytes: Uint8Array): FastCdcChunk[] {
  const chunks: FastCdcChunk[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const length = cutLength(bytes, offset, bytes.length - offset, DEFAULT_CONFIG);
    if (length <= 0) {
      throw new Error(`FastCDC produced a zero-length chunk at byte ${offset}.`);
    }
    chunks.push({ offset, length });
    offset += length;
  }
  return chunks;
}
