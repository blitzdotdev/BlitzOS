/**
 * Decode a standard (non-URL-safe) base64 string into raw bytes. Used for binary
 * file contents (e.g. images) that are base64-encoded for JSON/Streams transport.
 */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
