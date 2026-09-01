export const LORO_SIGNATURE_HEADER = 'X-Lody-Signature';
export const LORO_SIGNATURE_TIMESTAMP_HEADER = 'X-Lody-Timestamp';
export const LORO_SIGNATURE_VERSION_HEADER = 'X-Lody-Signature-Version';
export const LORO_SIGNATURE_VERSION = 'v1';
export const LORO_STREAMS_SESSION_CREATE_BOOTSTRAP_ACTION_PATH =
  'sessionBootstrap:bootstrapSessionCreateInStreams';
export const LORO_STREAMS_SESSION_CREATE_BOOTSTRAP_SIGNATURE_PATH = `/api/action/${LORO_STREAMS_SESSION_CREATE_BOOTSTRAP_ACTION_PATH}`;
export const LORO_STREAMS_SERVER_TOKEN_PATH = '/api/loro-streams/server-token';

export const SIGNING_ALGORITHM = { name: 'HMAC', hash: 'SHA-256' } as const;

export function buildCanonicalPayload(
  timestamp: string,
  method: string,
  path: string,
  body: string
): string {
  return [timestamp, method.toUpperCase(), path, body].join('\n');
}

export function bufferToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}
