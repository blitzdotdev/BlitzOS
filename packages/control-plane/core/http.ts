const MAX_BODY_BYTES = 64 * 1024;

export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue;
}

export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 402 | 403 | 404 | 409 | 413 | 429 | 502 | 503,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
  }
}

/** The part of Hono's `HTTPException` that decides a response. teenybase's own
 * framework errors extend it — `ProcessError`, `HTTPError` — so a thrown
 * "Not found" already carries the 404 it deserves. */
interface StatusBearingError {
  readonly status: number;
  getResponse(): Response;
}

/** A status and message the thrower already chose, safe to return as-is. */
export interface FrameworkHttpError {
  readonly status: number;
  readonly message: string;
}

/** Matched structurally rather than with `instanceof HTTPException`: the
 * emitted managed copies of `core/` may import nothing but relative
 * specifiers, so the class itself is out of reach there. Both marks are
 * required, so an ordinary `Error` that happens to carry a `status` field
 * stays an unknown throw. */
function isStatusBearingError(error: Error): error is Error & StatusBearingError {
  if (!("status" in error) || !("getResponse" in error)) return false;
  return (
    typeof error.getResponse === "function" &&
    isNumber(error.status) &&
    Number.isInteger(error.status) &&
    error.status >= 400 &&
    error.status <= 599
  );
}

/**
 * The HTTP meaning a framework error carries, or null when the throw has none
 * and must stay an opaque 500. A framework error is a deliberate signal: its
 * status and message are authored, not incidental, so both are returned.
 */
export function frameworkHttpError(error: Error): FrameworkHttpError | null {
  if (!isStatusBearingError(error)) return null;
  return {
    status: error.status,
    // `new HTTPException(404)` carries no message at all; an empty `error`
    // field reads as a broken response rather than a missing row.
    message: error.message.length > 0 ? error.message : "request failed",
  };
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

/** The root answers differently per visitor: marketing with no session, the
 * app shell with one. A shared cache holding either copy hands it to the wrong
 * person, so the answer is never stored and the cookie is named as the thing
 * it varies on. The asset binding sends `public, max-age=0` with the file it
 * serves; this replaces those headers rather than adding to them. */
export function perSessionResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store");
  headers.set("Vary", "Cookie");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
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
