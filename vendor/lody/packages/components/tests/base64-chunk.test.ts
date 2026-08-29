import { describe, expect, it } from 'vitest';
import { Base64ChunkEncoder, bytesToBase64 } from '../src/lib/base64-chunk';

/** Decode standard base64 → bytes (test-side reference, mirrors native decode). */
function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function makeBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31 + 7) & 0xff;
  return out;
}

describe('bytesToBase64', () => {
  it('matches atob/btoa round-trip for various lengths', () => {
    for (const n of [0, 1, 2, 3, 4, 5, 100, 1000, 0x8000 + 5]) {
      const bytes = makeBytes(n);
      const b64 = bytesToBase64(bytes);
      expect(base64ToBytes(b64)).toEqual(bytes);
    }
  });

  it('handles all byte values (0..255)', () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });
});

describe('Base64ChunkEncoder', () => {
  /** Push `bytes` split into `sliceLen`-sized pieces; concat segments + flush. */
  function encodeChunked(bytes: Uint8Array, sliceLen: number): string {
    const enc = new Base64ChunkEncoder();
    let out = '';
    for (let offset = 0; offset < bytes.length; offset += sliceLen) {
      const seg = enc.push(bytes.subarray(offset, offset + sliceLen));
      if (seg) out += seg;
    }
    const tail = enc.flush();
    if (tail) out += tail;
    return out;
  }

  it('concatenated chunk segments round-trip to the original bytes', () => {
    // The key invariant: appending independently-encoded base64 segments must
    // decode back to the original stream. Only possible if each non-final
    // segment is 3-byte-aligned (no mid-stream padding).
    for (const total of [0, 1, 2, 3, 4, 7, 8, 9, 256, 1000, 4096, 5001]) {
      for (const sliceLen of [1, 2, 3, 4, 5, 7, 64, 1000]) {
        const bytes = makeBytes(total);
        const b64 = encodeChunked(bytes, sliceLen);
        expect(base64ToBytes(b64), `total=${total} slice=${sliceLen}`).toEqual(bytes);
      }
    }
  });

  it('emits only 3-byte-aligned (unpadded) segments before flush', () => {
    const enc = new Base64ChunkEncoder();
    // 1 byte: nothing aligns yet.
    expect(enc.push(new Uint8Array([1]))).toBeNull();
    // +1 byte (2 total): still no full triplet.
    expect(enc.push(new Uint8Array([2]))).toBeNull();
    // +1 byte (3 total): one full triplet → a 4-char unpadded segment.
    const seg = enc.push(new Uint8Array([3]));
    expect(seg).not.toBeNull();
    expect(seg).toHaveLength(4);
    expect(seg).not.toContain('=');
    // Nothing left to flush.
    expect(enc.flush()).toBeNull();
  });

  it('flush encodes a sub-triplet remainder with padding exactly once', () => {
    const enc = new Base64ChunkEncoder();
    expect(enc.push(new Uint8Array([0xff, 0xee]))).toBeNull();
    const tail = enc.flush();
    expect(tail).not.toBeNull();
    expect(tail).toContain('=');
    expect(base64ToBytes(tail!)).toEqual(new Uint8Array([0xff, 0xee]));
  });

  it('empty input produces empty output', () => {
    expect(encodeChunked(new Uint8Array(0), 3)).toBe('');
  });

  it('is reusable after flush', () => {
    const enc = new Base64ChunkEncoder();
    enc.push(new Uint8Array([1, 2]));
    enc.flush();
    // Second round must not carry stale remainder.
    expect(enc.push(new Uint8Array([3, 4, 5]))).not.toBeNull();
    expect(enc.flush()).toBeNull();
  });
});
