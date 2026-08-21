const MAX_BODY_BYTES = 64 * 1024;

export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue;
}

export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 502 | 503,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
  }
}

export async function readText(
  request: Request,
  maxBytes = MAX_BODY_BYTES,
): Promise<string> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    throw new HttpError(413, "request body is too large");
  }
  if (request.body === null) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    size += result.value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new HttpError(413, "request body is too large");
    }
    chunks.push(result.value);
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

export async function readJson(
  request: Request,
  maxBytes = MAX_BODY_BYTES,
): Promise<JsonValue> {
  const text = await readText(request, maxBytes);
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
}

export async function readForm(request: Request): Promise<URLSearchParams> {
  return new URLSearchParams(await readText(request));
}

export function isRecord<Value>(value: Value): value is Value & JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isString<Value>(value: Value): value is Value & string {
  return typeof value === "string";
}

export function isNumber<Value>(value: Value): value is Value & number {
  return typeof value === "number";
}

export function isBoolean<Value>(value: Value): value is Value & boolean {
  return typeof value === "boolean";
}

export function requiredString<Value>(
  value: Value,
  field: string,
  maxLength = 16_384,
): string {
  if (!isString(value) || value.length === 0 || value.length > maxLength) {
    throw new HttpError(400, `${field} must be a non-empty string`);
  }
  return value;
}

export function positiveInteger<Value>(value: Value, field: string): number {
  if (!isNumber(value) || !Number.isSafeInteger(value) || value <= 0) {
    throw new HttpError(400, `${field} must be a positive integer`);
  }
  return value;
}

export function isSshPublicKey<Value>(value: Value): value is Value & string {
  if (typeof value !== "string") return false;
  const [algorithm, encoded] = value.trim().split(/\s+/u, 3);
  return (
    algorithm !== undefined &&
    encoded !== undefined &&
    (algorithm.startsWith("ssh-") ||
      algorithm.startsWith("ecdsa-") ||
      algorithm.startsWith("sk-")) &&
    /^[A-Za-z0-9+/]+={0,3}$/u.test(encoded)
  );
}
