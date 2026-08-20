const JSON_RESPONSE_MAX_BYTES = 64 * 1024;
const JSON_REQUEST_TIMEOUT_MS = 75_000;

export type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue;
}

export interface BoundedJsonFetchOptions {
  responseLabel: string;
  bodyDisposition(response: Response): "read" | "omit";
  invalidJsonDisposition(response: Response): "native-error" | "null" | "provider-error";
}

export interface BoundedJsonResponse {
  response: Response;
  body: JsonValue | null;
}

/** Bounded text reader for providers whose API is not JSON (the EC2 query
 * protocol answers in XML). Same cap and timeout as the JSON path so every
 * core HTTP call keeps one set of limits. */
export interface BoundedTextFetchOptions {
  responseLabel: string;
  bodyDisposition(response: Response): "read" | "omit";
}

export interface BoundedTextResponse {
  response: Response;
  body: string | null;
}

async function readBoundedText(
  response: Response,
  responseLabel: string,
): Promise<string | null> {
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d+$/u.test(declared) || Number(declared) > JSON_RESPONSE_MAX_BYTES)
  ) {
    throw new Error(`${responseLabel} response is too large`);
  }
  if (response.body === null) return null;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    size += result.value.byteLength;
    if (size > JSON_RESPONSE_MAX_BYTES) {
      await reader.cancel();
      throw new Error(`${responseLabel} response is too large`);
    }
    chunks.push(result.value);
  }
  if (size === 0) return null;
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

async function readBoundedJson(
  response: Response,
  options: BoundedJsonFetchOptions,
): Promise<JsonValue | null> {
  const text = await readBoundedText(response, options.responseLabel);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch (cause) {
    const disposition = options.invalidJsonDisposition(response);
    if (disposition === "null") return null;
    if (disposition === "native-error") throw cause;
    throw new Error(`${options.responseLabel} returned invalid JSON`);
  }
}

export async function fetchBoundedJson(
  fetcher: Fetcher,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  options: BoundedJsonFetchOptions,
): Promise<BoundedJsonResponse> {
  const timeoutSignal = AbortSignal.timeout(JSON_REQUEST_TIMEOUT_MS);
  const callerSignal = init?.signal;
  const signal = callerSignal === undefined || callerSignal === null
    ? timeoutSignal
    : AbortSignal.any([callerSignal, timeoutSignal]);
  const response = await fetcher(input, { ...init, signal });
  if (options.bodyDisposition(response) === "omit") return { response, body: null };
  return { response, body: await readBoundedJson(response, options) };
}

export async function fetchBoundedText(
  fetcher: Fetcher,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  options: BoundedTextFetchOptions,
): Promise<BoundedTextResponse> {
  const timeoutSignal = AbortSignal.timeout(JSON_REQUEST_TIMEOUT_MS);
  const callerSignal = init?.signal;
  const signal = callerSignal === undefined || callerSignal === null
    ? timeoutSignal
    : AbortSignal.any([callerSignal, timeoutSignal]);
  const response = await fetcher(input, { ...init, signal });
  if (options.bodyDisposition(response) === "omit") return { response, body: null };
  return { response, body: await readBoundedText(response, options.responseLabel) };
}
