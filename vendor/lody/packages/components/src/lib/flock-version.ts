import { encodeVersionVector, type Flock } from '@loro-dev/flock-wasm';

export type FlockVersionToken = Uint8Array;

export function readFlockVersionToken(
  flock: Partial<Pick<Flock, 'version'>>
): FlockVersionToken | null {
  if (typeof flock.version !== 'function') return null;
  return encodeVersionVector(flock.version());
}

export function flockVersionTokensEqual(
  left: FlockVersionToken | null | undefined,
  right: FlockVersionToken | null
): boolean {
  if (!left || !right || left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
