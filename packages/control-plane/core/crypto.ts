const encoder = new TextEncoder();
export const DUMMY_HASH = "0".repeat(64);

/** Unpadded base64url of raw bytes: the one encoding for tokens, invite-code
 * hashes, OAuth state payloads, and webApp ticket segments. */
export function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

/** Inverse of {@link base64Url}; null for anything that is not unpadded
 * base64url, so callers reject a malformed segment instead of decoding it. */
export function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const padded = value.replaceAll("-", "+").replaceAll("_", "/")
    + "=".repeat((4 - (value.length % 4)) % 4);
  try {
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

export function randomToken(bytes = 32): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function hashSecret(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function hashBytes(value: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/u.test(value)) return new Uint8Array(32);
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export function safeEqualHash(left: string, right: string): boolean {
  return crypto.subtle.timingSafeEqual(hashBytes(left), hashBytes(right));
}

export async function safeEqualSecret(
  provided: string,
  expected: string,
): Promise<boolean> {
  const [providedHash, expectedHash] = await Promise.all([
    hashSecret(provided),
    hashSecret(expected),
  ]);
  return safeEqualHash(providedHash, expectedHash);
}

export async function matchesStoredHash(
  provided: string,
  storedHash: string,
): Promise<boolean> {
  return safeEqualHash(await hashSecret(provided), storedHash);
}

export function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length);
  return token.length > 0 ? token : null;
}
