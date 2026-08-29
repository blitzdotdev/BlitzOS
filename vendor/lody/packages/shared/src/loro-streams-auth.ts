import { z } from 'zod';
import { getServerNow } from './time-sync';

export const LoroStreamsTokenRequestSchema = z.object({
  workspaceId: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/),
});

export const LoroStreamsTokenResponseSchema = z.object({
  token: z.string(),
  expiresIn: z.number().int().positive(),
  gatewayBaseUrl: z.string().url().optional(),
  // Hosted shard topology (bare host suffix, e.g. "streams.example.com"):
  // when present, clients spread presence/control/write traffic across the
  // sibling subdomains under this suffix instead of piling every SSE stream
  // onto the gateway origin. Validated again client-side before use.
  shardHostSuffix: z.string().min(1).max(253).optional(),
});

export type LoroStreamsTokenRequest = z.infer<typeof LoroStreamsTokenRequestSchema>;
export type LoroStreamsTokenResponse = z.infer<typeof LoroStreamsTokenResponseSchema>;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

type CachedLoroStreamsToken = {
  token: string;
  expiresAtMs: number;
  gatewayBaseUrl?: string;
  shardHostSuffix?: string;
};

export const LORO_STREAMS_TOKEN_REFRESH_SKEW_MS = 30_000;
export const LORO_STREAMS_TOKEN_STORAGE_KEY_PREFIX = 'lody:loroStreamsToken';

const LORO_STREAMS_TOKEN_STORAGE_VERSION = 2;
const LORO_STREAMS_TOKEN_STORAGE_ALGORITHM = 'AES-GCM';
const LORO_STREAMS_TOKEN_STORAGE_IV_BYTES = 12;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const CachedLoroStreamsTokenSchema = z.object({
  token: z.string().min(1),
  expiresAtMs: z.number().finite(),
  gatewayBaseUrl: z.string().url().optional(),
  shardHostSuffix: z.string().min(1).max(253).optional(),
});

const EncryptedLoroStreamsTokenStorageSchema = z.object({
  version: z.literal(LORO_STREAMS_TOKEN_STORAGE_VERSION),
  algorithm: z.literal(LORO_STREAMS_TOKEN_STORAGE_ALGORITHM),
  iv: z.string().min(1),
  ciphertext: z.string().min(1),
});

const LegacyPlaintextLoroStreamsTokenStorageSchema = z.object({
  token: z.string(),
  expiresAtMs: z.number(),
});

type MinimalStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

function isMinimalStorage(value: unknown): value is MinimalStorage {
  if (!value || typeof value !== 'object') {
    return false;
  }
  return (
    'getItem' in value &&
    'setItem' in value &&
    'removeItem' in value &&
    typeof value.getItem === 'function' &&
    typeof value.setItem === 'function' &&
    typeof value.removeItem === 'function'
  );
}

function getTokenStorageKey(workspaceId: string): string {
  return `${LORO_STREAMS_TOKEN_STORAGE_KEY_PREFIX}:${workspaceId}`;
}

function getLocalStorage(): MinimalStorage | undefined {
  try {
    const storage = Reflect.get(globalThis, 'localStorage') as unknown;
    if (isMinimalStorage(storage)) {
      return storage;
    }
  } catch {
    // ignore unavailable localStorage
  }
  return undefined;
}

function getSubtleCrypto() {
  try {
    return globalThis.crypto?.subtle;
  } catch {
    return undefined;
  }
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value: string): Uint8Array | null {
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padding = '='.repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(`${normalized}${padding}`);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

async function deriveTokenStorageKey(
  workspaceId: string,
  authToken: string
) {
  const subtle = getSubtleCrypto();
  if (!subtle) {
    return null;
  }

  // This is obfuscating-at-rest for localStorage, not an XSS boundary: deriving
  // from the current auth token lets refreshes reuse the cache while token
  // rotation naturally makes old ciphertext unreadable.
  const keyMaterial = textEncoder.encode(
    `lody:loroStreamsToken:v${LORO_STREAMS_TOKEN_STORAGE_VERSION}:${workspaceId}:${authToken}`
  );
  const digest = await subtle.digest('SHA-256', keyMaterial);
  return await subtle.importKey(
    'raw',
    digest,
    { name: LORO_STREAMS_TOKEN_STORAGE_ALGORITHM },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptCachedTokenForStorage(
  workspaceId: string,
  authToken: string,
  token: CachedLoroStreamsToken
): Promise<string | null> {
  const subtle = getSubtleCrypto();
  const key = await deriveTokenStorageKey(workspaceId, authToken);
  if (!subtle || !key) {
    return null;
  }

  const iv = new Uint8Array(LORO_STREAMS_TOKEN_STORAGE_IV_BYTES);
  globalThis.crypto.getRandomValues(iv);
  const plaintext = textEncoder.encode(JSON.stringify(token));
  const ciphertext = await subtle.encrypt(
    { name: LORO_STREAMS_TOKEN_STORAGE_ALGORITHM, iv: toArrayBuffer(iv) },
    key,
    plaintext
  );

  return JSON.stringify({
    version: LORO_STREAMS_TOKEN_STORAGE_VERSION,
    algorithm: LORO_STREAMS_TOKEN_STORAGE_ALGORITHM,
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
  });
}

async function decryptCachedTokenFromStorage(
  workspaceId: string,
  authToken: string,
  encrypted: z.infer<typeof EncryptedLoroStreamsTokenStorageSchema>
): Promise<CachedLoroStreamsToken | null> {
  const subtle = getSubtleCrypto();
  const key = await deriveTokenStorageKey(workspaceId, authToken);
  const iv = base64UrlToBytes(encrypted.iv);
  const ciphertext = base64UrlToBytes(encrypted.ciphertext);
  if (!subtle || !key || !iv || !ciphertext) {
    return null;
  }

  try {
    const plaintext = await subtle.decrypt(
      { name: LORO_STREAMS_TOKEN_STORAGE_ALGORITHM, iv: toArrayBuffer(iv) },
      key,
      toArrayBuffer(ciphertext)
    );
    const parsedJson = JSON.parse(textDecoder.decode(plaintext));
    const parsed = CachedLoroStreamsTokenSchema.safeParse(parsedJson);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function readCachedTokenFromStorage(
  workspaceId: string,
  authToken: string
): Promise<CachedLoroStreamsToken | null> {
  const storage = getLocalStorage();
  if (!storage) {
    return null;
  }

  const storageKey = getTokenStorageKey(workspaceId);
  try {
    const raw = storage.getItem(storageKey);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as unknown;
    const encrypted = EncryptedLoroStreamsTokenStorageSchema.safeParse(parsed);
    if (!encrypted.success) {
      if (LegacyPlaintextLoroStreamsTokenStorageSchema.safeParse(parsed).success) {
        storage.removeItem(storageKey);
      }
      return null;
    }

    const token = await decryptCachedTokenFromStorage(workspaceId, authToken, encrypted.data);
    if (!token) {
      storage.removeItem(storageKey);
    }
    return token;
  } catch {
    try {
      storage.removeItem(storageKey);
    } catch {
      // ignore
    }
    return null;
  }
}

async function writeCachedTokenToStorage(
  workspaceId: string,
  authToken: string,
  token: CachedLoroStreamsToken
): Promise<void> {
  const storage = getLocalStorage();
  if (!storage) {
    return;
  }

  try {
    const encrypted = await encryptCachedTokenForStorage(workspaceId, authToken, token);
    if (!encrypted) {
      return;
    }
    storage.setItem(getTokenStorageKey(workspaceId), encrypted);
  } catch {
    // ignore cache write failures, including quota and WebCrypto errors
  }
}

function clearCachedTokenFromStorage(workspaceId: string): void {
  const storage = getLocalStorage();
  if (!storage) {
    return;
  }

  try {
    storage.removeItem(getTokenStorageKey(workspaceId));
  } catch {
    // ignore
  }
}

export type LoroStreamsTokenProviderEvent =
  | {
      type: 'cache-hit';
      workspaceId: string;
      expiresInMs: number;
      hasGatewayBaseUrl: boolean;
    }
  | {
      type: 'cache-miss';
      workspaceId: string;
      reason: 'missing' | 'expired-or-stale';
    }
  | {
      type: 'fetch-start';
      workspaceId: string;
      endpoint: string;
    }
  | {
      type: 'fetch-success';
      workspaceId: string;
      expiresInMs: number;
      hasGatewayBaseUrl: boolean;
    }
  | {
      type: 'fetch-failure';
      workspaceId: string;
      status?: number;
      error: unknown;
    }
  | {
      type: 'in-flight-reuse';
      workspaceId: string;
    }
  | {
      type: 'invalidate';
      workspaceId: string;
      reason: 'manual' | 'unauthorized';
    };

export const buildLoroStreamsTokenEndpoint = (baseUrl: string): string =>
  `${baseUrl.replace(/\/+$/g, '')}/api/loro-streams/token`;

/**
 * Thrown when `/api/loro-streams/token` rejects the caller's long-lived
 * credentials as 401/403. Direct `getToken()` callers should treat this as
 * fatal: the CLI token has been revoked (or was never valid for this
 * workspace) and no amount of retrying will recover it. Transport auth
 * callbacks convert this to `undefined` so streams-crdt can surface
 * `auth_failed` instead of retryable `auth_provider_error`.
 */
export class LoroStreamsTokenAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: string
  ) {
    super(message);
    this.name = 'LoroStreamsTokenAuthError';
  }
}

export function createLoroStreamsTokenProvider(options: {
  endpoint: string;
  workspaceId: string;
  authToken:
    | string
    | null
    | undefined
    | (() => Promise<string | null | undefined> | string | null | undefined);
  fetchImpl?: FetchLike;
  refreshSkewMs?: number;
  onEvent?: (event: LoroStreamsTokenProviderEvent) => void;
}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const refreshSkewMs = options.refreshSkewMs ?? LORO_STREAMS_TOKEN_REFRESH_SKEW_MS;
  let cached: CachedLoroStreamsToken | null = null;
  let inFlight: Promise<CachedLoroStreamsToken> | null = null;
  let storageReadInFlight: Promise<CachedLoroStreamsToken | null> | null = null;
  let generation = 0;
  // Cache permanent 401/403 rejections per-auth-token so a forbidden long-lived
  // credential doesn't keep hammering /api/loro-streams/token. We retain the
  // rejection until either (a) the resolved auth token changes (e.g. user
  // re-authenticated) or (b) a `manual` invalidate(). `unauthorized` invalidation
  // (driven by the streams-crdt callback) deliberately does NOT clear it — the
  // same forbidden token would just trigger the same 401/403 again.
  let terminalAuthFailure:
    | {
        authToken: string;
        error: LoroStreamsTokenAuthError;
      }
    | null = null;

  const emit = (event: LoroStreamsTokenProviderEvent): void => {
    options.onEvent?.(event);
  };

  const resolveAuthToken = async (): Promise<string | null | undefined> => {
    const { authToken } = options;
    return typeof authToken === 'function' ? await authToken() : authToken;
  };

  const fetchToken = async (): Promise<CachedLoroStreamsToken> => {
    // Resolve and check terminalAuthFailure *inside* fetchToken so that
    // `inFlight = fetchToken()` is a single synchronous assignment — concurrent
    // ensureFreshToken() callers reuse the same in-flight promise (and therefore
    // share one resolveAuthToken() call) instead of each doing their own resolve
    // before racing on `if (!inFlight)`.
    const currentAuthToken = await resolveAuthToken();
    if (terminalAuthFailure) {
      if (terminalAuthFailure.authToken === currentAuthToken) {
        throw terminalAuthFailure.error;
      }
      terminalAuthFailure = null;
    }
    emit({
      type: 'fetch-start',
      workspaceId: options.workspaceId,
      endpoint: options.endpoint,
    });
    try {
      if (!currentAuthToken) {
        throw new LoroStreamsTokenAuthError('Missing Loro Streams token provider auth token', 401);
      }
      const response = await fetchImpl(options.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${currentAuthToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          workspaceId: LoroStreamsTokenRequestSchema.shape.workspaceId.parse(options.workspaceId),
        } satisfies LoroStreamsTokenRequest),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        const message = `Failed to fetch Loro Streams token (status=${response.status}${detail ? ` detail=${detail}` : ''})`;
        if (response.status === 401 || response.status === 403) {
          const authError = new LoroStreamsTokenAuthError(
            message,
            response.status,
            detail || undefined
          );
          terminalAuthFailure = {
            authToken: currentAuthToken,
            error: authError,
          };
          throw authError;
        }
        throw new Error(message);
      }

      const raw = await response.json().catch(() => null);
      const parsed = LoroStreamsTokenResponseSchema.safeParse(raw);
      if (!parsed.success) {
        throw new Error('Invalid Loro Streams token response');
      }

      const nextToken = {
        token: parsed.data.token,
        // Use calibrated server time so this expiry matches the
        // gateway's `exp` claim regardless of local clock skew. A
        // client clock that's slow by >refreshSkewMs would otherwise
        // keep handing back an actually-expired token to the gateway,
        // bouncing through 401s until the next refresh tick.
        expiresAtMs: getServerNow() + parsed.data.expiresIn * 1000,
        gatewayBaseUrl: parsed.data.gatewayBaseUrl,
        shardHostSuffix: parsed.data.shardHostSuffix,
      };
      emit({
        type: 'fetch-success',
        workspaceId: options.workspaceId,
        expiresInMs: parsed.data.expiresIn * 1000,
        hasGatewayBaseUrl: typeof parsed.data.gatewayBaseUrl === 'string',
      });
      terminalAuthFailure = null;
      return nextToken;
    } catch (error) {
      emit({
        type: 'fetch-failure',
        workspaceId: options.workspaceId,
        status: error instanceof LoroStreamsTokenAuthError ? error.status : undefined,
        error,
      });
      throw error;
    }
  };

  const isFresh = (token: CachedLoroStreamsToken, nowMs = getServerNow()): boolean =>
    nowMs < token.expiresAtMs - refreshSkewMs;

  const hydrateFromStorage = async (): Promise<void> => {
    if (cached) {
      return;
    }
    const currentAuthToken = await resolveAuthToken();
    if (!currentAuthToken) {
      return;
    }
    if (!storageReadInFlight) {
      storageReadInFlight = readCachedTokenFromStorage(
        options.workspaceId,
        currentAuthToken
      ).finally(() => {
        storageReadInFlight = null;
      });
    }
    const stored = await storageReadInFlight;
    if (stored && !cached) {
      cached = stored;
    }
  };

  const ensureFreshToken = async (): Promise<CachedLoroStreamsToken> => {
    let nowMs = getServerNow();
    if (cached && isFresh(cached, nowMs)) {
      emit({
        type: 'cache-hit',
        workspaceId: options.workspaceId,
        expiresInMs: cached.expiresAtMs - nowMs,
        hasGatewayBaseUrl: typeof cached.gatewayBaseUrl === 'string',
      });
      return cached;
    }

    if (!cached) {
      await hydrateFromStorage();
    }

    nowMs = getServerNow();
    if (cached && isFresh(cached, nowMs)) {
      emit({
        type: 'cache-hit',
        workspaceId: options.workspaceId,
        expiresInMs: cached.expiresAtMs - nowMs,
        hasGatewayBaseUrl: typeof cached.gatewayBaseUrl === 'string',
      });
      return cached;
    }

    emit({
      type: 'cache-miss',
      workspaceId: options.workspaceId,
      reason: cached ? 'expired-or-stale' : 'missing',
    });
    if (cached) {
      clearCachedTokenFromStorage(options.workspaceId);
    }

    if (!inFlight) {
      const fetchGeneration = generation;
      inFlight = fetchToken()
        .then(async (nextToken) => {
          if (generation === fetchGeneration) {
            cached = nextToken;
            try {
              const currentAuthToken = await resolveAuthToken();
              if (currentAuthToken) {
                await writeCachedTokenToStorage(options.workspaceId, currentAuthToken, nextToken);
              }
            } catch {
              // The token is already valid in memory; persistent cache writes are best effort.
            }
          }
          return nextToken;
        })
        .finally(() => {
          if (generation === fetchGeneration) {
            inFlight = null;
          }
        });
    } else {
      emit({
        type: 'in-flight-reuse',
        workspaceId: options.workspaceId,
      });
    }

    return await inFlight;
  };

  const invalidate = (reason: 'manual' | 'unauthorized' = 'manual'): void => {
    cached = null;
    inFlight = null;
    storageReadInFlight = null;
    generation++;
    if (reason === 'manual') {
      terminalAuthFailure = null;
    }
    clearCachedTokenFromStorage(options.workspaceId);
    emit({
      type: 'invalidate',
      workspaceId: options.workspaceId,
      reason,
    });
  };

  return {
    getToken: async (): Promise<string> => {
      const current = await ensureFreshToken();
      return current.token;
    },
    /** Force the next `getToken()` call to fetch a fresh token from the server. */
    invalidate,
    getGatewayBaseUrl: (): string | undefined => cached?.gatewayBaseUrl,
    /** Hosted shard topology from the token response; undefined until a token has been fetched. */
    getShardHostSuffix: (): string | undefined => cached?.shardHostSuffix,
    /**
     * Returns an auth callback compatible with `StreamsTransportAdapter` / `StreamsCrdt`.
     * On `reason: "unauthorized"`, invalidates the cached token before fetching a fresh one.
     */
    createAuthCallback: (): ((context?: { reason: string }) => Promise<string | undefined>) => {
      return async (context) => {
        if (context?.reason === 'unauthorized') {
          invalidate('unauthorized');
        }
        try {
          const current = await ensureFreshToken();
          return current.token;
        } catch (error) {
          if (error instanceof LoroStreamsTokenAuthError) {
            invalidate('unauthorized');
            return undefined;
          }
          throw error;
        }
      };
    },
  };
}
