/**
 * Pure helpers for streaming binary bytes into base64 in bounded chunks.
 *
 * Capacitor Filesystem's `appendFile` takes a base64 string (no `Encoding`)
 * and decodes it back to raw bytes on the native side. To write a large file
 * without ever holding the whole thing in memory, we encode and append in
 * chunks. The catch: base64 encodes 3 input bytes → 4 output chars, so a chunk
 * boundary that falls mid-triplet would emit padding (`=`) in the middle of the
 * stream and corrupt the decoded file. We therefore only encode whole 3-byte
 * groups per chunk and carry the 0–2 trailing bytes into the next chunk; the
 * final flush encodes the remainder (with padding, exactly once, at the end).
 */

/** base64 over a Uint8Array using only `String.fromCharCode` + `btoa` (no Buffer). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  // Build the binary string in sub-chunks so `fromCharCode(...spread)` never
  // blows the call-stack argument limit on large inputs.
  const STRIDE = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += STRIDE) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + STRIDE));
  }
  return btoa(binary);
}

/**
 * Accumulates incoming byte slices and yields base64 only on 3-byte-aligned
 * boundaries, buffering the unaligned tail until `flush()`. This keeps every
 * intermediate base64 segment independently decodable, so they can be appended
 * back-to-back on the native side and round-trip to the original bytes.
 */
export class Base64ChunkEncoder {
  /** Carried bytes that did not fit a 3-byte group in the previous push. */
  private remainder: Uint8Array = new Uint8Array(0);

  /**
   * Encode as much of `bytes` (plus any carried remainder) as aligns to a
   * 3-byte boundary. Returns the base64 segment, or `null` when nothing is
   * ready yet (fewer than 3 bytes accumulated).
   */
  push(bytes: Uint8Array): string | null {
    if (bytes.length === 0) {
      return null;
    }
    const total = this.remainder.length + bytes.length;
    const alignedLen = total - (total % 3);
    if (alignedLen === 0) {
      // Not even one full triplet yet — keep buffering.
      this.remainder = concat(this.remainder, bytes);
      return null;
    }
    const combined = concat(this.remainder, bytes);
    const encodable = combined.subarray(0, alignedLen);
    this.remainder = combined.slice(alignedLen);
    return bytesToBase64(encodable);
  }

  /**
   * Encode and return the final (possibly unaligned) remainder, applying
   * base64 padding. Returns `null` when there is nothing left. After this the
   * encoder is reset and reusable.
   */
  flush(): string | null {
    if (this.remainder.length === 0) {
      return null;
    }
    const tail = this.remainder;
    this.remainder = new Uint8Array(0);
    return bytesToBase64(tail);
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
