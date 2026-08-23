const encoder = new TextEncoder();
export const DUMMY_HASH = "0".repeat(64);

export function randomToken(bytes = 32): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export async function hashSecret(value: string): Promise<string> {
  return sha256Hex(encoder.encode(value));
}

export async function sha256Hex(value: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", value);
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
