import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildLoroStreamsTokenEndpoint,
  createLoroStreamsTokenProvider,
  LORO_STREAMS_TOKEN_STORAGE_KEY_PREFIX,
  LoroStreamsTokenRequestSchema,
} from '../src/loro-streams-auth';

type LocalStorageMock = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
};

function createLocalStorageMock(): LocalStorageMock {
  let store: Record<string, string> = {};
  return {
    getItem(key: string) {
      return store[key] ?? null;
    },
    setItem(key: string, value: string) {
      store[key] = value;
    },
    removeItem(key: string) {
      delete store[key];
    },
    clear() {
      store = {};
    },
  };
}

describe('loro streams auth helpers', () => {
  let localStorageMock: LocalStorageMock;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-19T00:00:00.000Z'));
    localStorageMock = createLocalStorageMock();
    Object.defineProperty(globalThis, 'localStorage', {
      value: localStorageMock,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(globalThis, 'localStorage', {
      value: undefined,
      writable: true,
      configurable: true,
    });
  });

  it('builds the token endpoint from a base url', () => {
    expect(buildLoroStreamsTokenEndpoint('https://convex.example.com/')).toBe(
      'https://convex.example.com/api/loro-streams/token'
    );
  });

  it('normalizes and validates token request workspace ids', () => {
    expect(LoroStreamsTokenRequestSchema.parse({ workspaceId: ' workspace-1 ' })).toEqual({
      workspaceId: 'workspace-1',
    });

    expect(LoroStreamsTokenRequestSchema.safeParse({ workspaceId: 'workspace/1' }).success).toBe(
      false
    );
    expect(LoroStreamsTokenRequestSchema.safeParse({ workspaceId: '' }).success).toBe(false);
  });

  it('caches the token until it is near expiry', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            token: 'jwt-1',
            expiresIn: 900,
            gatewayBaseUrl: 'https://streams-api.example.com',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
    );

    const provider = createLoroStreamsTokenProvider({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: 'raw-token',
      fetchImpl,
    });

    await expect(provider.getToken()).resolves.toBe('jwt-1');
    await expect(provider.getToken()).resolves.toBe('jwt-1');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(provider.getGatewayBaseUrl()).toBe('https://streams-api.example.com');
  });

  it('refreshes the token after the cache window', async () => {
    let counter = 0;
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            token: `jwt-${++counter}`,
            expiresIn: 60,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
    );

    const provider = createLoroStreamsTokenProvider({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: 'raw-token',
      fetchImpl,
      refreshSkewMs: 5_000,
    });

    await expect(provider.getToken()).resolves.toBe('jwt-1');
    vi.advanceTimersByTime(54_000);
    await expect(provider.getToken()).resolves.toBe('jwt-1');
    vi.advanceTimersByTime(2_000);
    await expect(provider.getToken()).resolves.toBe('jwt-2');

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('supports a getter function for authToken that is called on each fetch', async () => {
    let currentToken = 'token-v1';
    let counter = 0;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const authHeader = (init?.headers as Record<string, string>)?.Authorization;
      return new Response(
        JSON.stringify({
          token: `jwt-${++counter}-${authHeader}`,
          expiresIn: 60,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const provider = createLoroStreamsTokenProvider({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: () => currentToken,
      fetchImpl,
      refreshSkewMs: 5_000,
    });

    // First fetch uses token-v1
    const jwt1 = await provider.getToken();
    expect(jwt1).toBe('jwt-1-Bearer token-v1');

    // Simulate auth token refresh (e.g. after sleep/wake)
    currentToken = 'token-v2';

    // Advance past cache window to force re-fetch
    vi.advanceTimersByTime(56_000);
    const jwt2 = await provider.getToken();
    expect(jwt2).toBe('jwt-2-Bearer token-v2');

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('supports an async getter function for authToken', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ token: 'jwt-async', expiresIn: 900 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    );

    const provider = createLoroStreamsTokenProvider({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: async () => 'async-token',
      fetchImpl,
    });

    await expect(provider.getToken()).resolves.toBe('jwt-async');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://convex.example.com/api/loro-streams/token',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer async-token',
        }),
      })
    );
  });

  it('does not fail a successful token fetch when persistent cache auth lookup fails', async () => {
    let authTokenCalls = 0;
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ token: 'jwt-1', expiresIn: 900 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    );

    const provider = createLoroStreamsTokenProvider({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: async () => {
        authTokenCalls++;
        if (authTokenCalls <= 2) {
          return 'raw-token';
        }
        throw new Error('session unavailable');
      },
      fetchImpl,
    });

    await expect(provider.getToken()).resolves.toBe('jwt-1');
    await expect(provider.getToken()).resolves.toBe('jwt-1');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('invalidate() forces a fresh token fetch on the next getToken() call', async () => {
    let counter = 0;
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ token: `jwt-${++counter}`, expiresIn: 900 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    );

    const provider = createLoroStreamsTokenProvider({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: 'raw-token',
      fetchImpl,
    });

    // First fetch
    await expect(provider.getToken()).resolves.toBe('jwt-1');
    // Still within cache window — should reuse cached token
    await expect(provider.getToken()).resolves.toBe('jwt-1');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Invalidate clears cache, forcing a fresh fetch
    provider.invalidate();
    await expect(provider.getToken()).resolves.toBe('jwt-2');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('invalidate() prevents a stale in-flight fetch from populating the cache', async () => {
    let resolveFetch: ((res: Response) => void) | null = null;

    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
    );

    const provider = createLoroStreamsTokenProvider({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: 'raw-token',
      fetchImpl,
    });

    // Start a fetch (goes in-flight); flush microtasks so resolveAuthToken() completes
    const tokenPromise1 = provider.getToken();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const staleResolve = resolveFetch!;

    // Invalidate while the first fetch is still in-flight
    provider.invalidate();

    // Start a new fetch (should create a new in-flight request)
    const tokenPromise2 = provider.getToken();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const freshResolve = resolveFetch!;

    // Resolve the stale fetch first — it must NOT overwrite the cache
    staleResolve(
      new Response(JSON.stringify({ token: 'stale-jwt', expiresIn: 900 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    await expect(tokenPromise1).resolves.toBe('stale-jwt');

    // Resolve the fresh fetch
    freshResolve(
      new Response(JSON.stringify({ token: 'fresh-jwt', expiresIn: 900 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    await expect(tokenPromise2).resolves.toBe('fresh-jwt');

    // Subsequent calls must return the fresh token, not the stale one
    await expect(provider.getToken()).resolves.toBe('fresh-jwt');
    // No additional fetch — the fresh token is cached
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('createAuthCallback() invalidates on unauthorized and returns a fresh token', async () => {
    let counter = 0;
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ token: `jwt-${++counter}`, expiresIn: 900 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    );

    const provider = createLoroStreamsTokenProvider({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: 'raw-token',
      fetchImpl,
    });

    const authCallback = provider.createAuthCallback();

    // Normal request — fetches and caches
    await expect(authCallback({ reason: 'request' })).resolves.toBe('jwt-1');
    await expect(authCallback({ reason: 'request' })).resolves.toBe('jwt-1');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Unauthorized — invalidates cache, fetches fresh token
    await expect(authCallback({ reason: 'unauthorized' })).resolves.toBe('jwt-2');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('createAuthCallback() returns undefined for permanent auth rejection', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('revoked', {
          status: 401,
        })
    );

    const provider = createLoroStreamsTokenProvider({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: 'revoked-token',
      fetchImpl,
    });

    const authCallback = provider.createAuthCallback();

    await expect(authCallback({ reason: 'request' })).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('createAuthCallback() does not refetch after permanent auth rejection for the same auth token', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('forbidden', {
          status: 403,
        })
    );

    const provider = createLoroStreamsTokenProvider({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: 'forbidden-token',
      fetchImpl,
    });

    const authCallback = provider.createAuthCallback();

    await expect(authCallback({ reason: 'request' })).resolves.toBeUndefined();
    await expect(authCallback({ reason: 'request' })).resolves.toBeUndefined();
    await expect(authCallback({ reason: 'unauthorized' })).resolves.toBeUndefined();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('terminal auth failure clears automatically once the auth token changes', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('forbidden', {
          status: 403,
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: 'jwt-after-rotation', expiresIn: 900 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

    let currentAuthToken: string = 'forbidden-token';
    const provider = createLoroStreamsTokenProvider({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: () => currentAuthToken,
      fetchImpl,
    });

    await expect(provider.getToken()).rejects.toThrow('status=403');
    await expect(provider.getToken()).rejects.toThrow('status=403');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    currentAuthToken = 'fresh-token';

    await expect(provider.getToken()).resolves.toBe('jwt-after-rotation');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('manual invalidate clears a permanent auth rejection so callers can retry', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('forbidden', {
          status: 403,
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: 'jwt-after-recovery', expiresIn: 900 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

    const provider = createLoroStreamsTokenProvider({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: 'forbidden-token',
      fetchImpl,
    });

    await expect(provider.getToken()).rejects.toThrow('status=403');
    await expect(provider.getToken()).rejects.toThrow('status=403');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    provider.invalidate();

    await expect(provider.getToken()).resolves.toBe('jwt-after-recovery');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('createAuthCallback() returns undefined when the caller has no auth token', async () => {
    const fetchImpl = vi.fn();

    const provider = createLoroStreamsTokenProvider({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: () => null,
      fetchImpl,
    });

    const authCallback = provider.createAuthCallback();

    await expect(authCallback({ reason: 'request' })).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('createAuthCallback() keeps transient token fetch failures retryable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('token service unavailable');
    });

    const provider = createLoroStreamsTokenProvider({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: 'raw-token',
      fetchImpl,
    });

    const authCallback = provider.createAuthCallback();

    await expect(authCallback({ reason: 'request' })).rejects.toThrow('token service unavailable');
  });

  it('reads an encrypted cached token from localStorage on initialization and avoids fetching', async () => {
    const storageKey = `${LORO_STREAMS_TOKEN_STORAGE_KEY_PREFIX}:workspace-1`;
    const firstFetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            token: 'jwt-from-network',
            expiresIn: 900,
            gatewayBaseUrl: 'https://streams-api.example.com',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
    );

    const firstProvider = createLoroStreamsTokenProvider({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: 'raw-token',
      fetchImpl: firstFetchImpl,
    });
    await expect(firstProvider.getToken()).resolves.toBe('jwt-from-network');
    const stored = localStorageMock.getItem(storageKey);
    expect(stored).not.toBeNull();
    expect(stored).not.toContain('jwt-from-network');

    const secondFetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ token: 'jwt-refetched', expiresIn: 900 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    );
    const secondProvider = createLoroStreamsTokenProvider({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: 'raw-token',
      fetchImpl: secondFetchImpl,
    });

    await expect(secondProvider.getToken()).resolves.toBe('jwt-from-network');
    expect(secondFetchImpl).not.toHaveBeenCalled();
    expect(secondProvider.getGatewayBaseUrl()).toBe('https://streams-api.example.com');
  });

  it('emits non-sensitive events for cache and fetch decisions', async () => {
    const events: unknown[] = [];
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ token: 'jwt-from-network', expiresIn: 900 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    );

    const provider = createLoroStreamsTokenProvider({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: 'raw-token',
      fetchImpl,
      onEvent: (event) => events.push(event),
    });

    await expect(provider.getToken()).resolves.toBe('jwt-from-network');
    await expect(provider.getToken()).resolves.toBe('jwt-from-network');

    expect(events).toEqual([
      expect.objectContaining({ type: 'cache-miss', reason: 'missing' }),
      expect.objectContaining({ type: 'fetch-start' }),
      expect.objectContaining({ type: 'fetch-success' }),
      expect.objectContaining({ type: 'cache-hit' }),
    ]);
    expect(JSON.stringify(events)).not.toContain('jwt-from-network');
  });

  it('writes fetched tokens to localStorage without storing plaintext JWTs', async () => {
    const storageKey = `${LORO_STREAMS_TOKEN_STORAGE_KEY_PREFIX}:workspace-1`;
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            token: 'jwt-1',
            expiresIn: 900,
            gatewayBaseUrl: 'https://streams-api.example.com',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
    );

    const provider = createLoroStreamsTokenProvider({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: 'raw-token',
      fetchImpl,
    });

    await provider.getToken();

    const stored = localStorageMock.getItem(storageKey);
    expect(stored).not.toBeNull();
    expect(stored).not.toContain('jwt-1');
    expect(JSON.parse(stored!)).toEqual({
      version: 2,
      algorithm: 'AES-GCM',
      iv: expect.any(String),
      ciphertext: expect.any(String),
    });

    provider.invalidate();

    expect(localStorageMock.getItem(storageKey)).toBeNull();
  });

  it('ignores an encrypted cache when the auth token changes and fetches a fresh JWT', async () => {
    const storageKey = `${LORO_STREAMS_TOKEN_STORAGE_KEY_PREFIX}:workspace-1`;
    const firstProvider = createLoroStreamsTokenProvider({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: 'raw-token-v1',
      fetchImpl: vi.fn(
        async () =>
          new Response(JSON.stringify({ token: 'jwt-v1', expiresIn: 900 }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
      ),
    });
    await expect(firstProvider.getToken()).resolves.toBe('jwt-v1');
    const encryptedWithV1 = localStorageMock.getItem(storageKey);
    expect(encryptedWithV1).not.toBeNull();

    const secondFetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ token: 'jwt-v2', expiresIn: 900 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    );
    const secondProvider = createLoroStreamsTokenProvider({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: 'raw-token-v2',
      fetchImpl: secondFetchImpl,
    });

    await expect(secondProvider.getToken()).resolves.toBe('jwt-v2');
    expect(secondFetchImpl).toHaveBeenCalledTimes(1);
    expect(localStorageMock.getItem(storageKey)).not.toBe(encryptedWithV1);
  });

  it('replaces legacy plaintext localStorage cache entries with encrypted cache entries', async () => {
    const storageKey = `${LORO_STREAMS_TOKEN_STORAGE_KEY_PREFIX}:workspace-1`;
    localStorageMock.setItem(
      storageKey,
      JSON.stringify({
        token: 'legacy-plaintext-jwt',
        expiresAtMs: Date.now() + 900_000,
        gatewayBaseUrl: 'https://streams-api.example.com',
      })
    );
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ token: 'jwt-fresh', expiresIn: 900 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    );

    const provider = createLoroStreamsTokenProvider({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: 'raw-token',
      fetchImpl,
    });

    await expect(provider.getToken()).resolves.toBe('jwt-fresh');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const stored = localStorageMock.getItem(storageKey);
    expect(stored).not.toBeNull();
    expect(stored).not.toContain('legacy-plaintext-jwt');
    expect(stored).not.toContain('jwt-fresh');
  });

  it('ignores encrypted localStorage cache entries inside the refresh skew', async () => {
    const firstProvider = createLoroStreamsTokenProvider({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: 'raw-token',
      fetchImpl: vi.fn(
        async () =>
          new Response(JSON.stringify({ token: 'jwt-stale', expiresIn: 10 }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
      ),
    });
    await expect(firstProvider.getToken()).resolves.toBe('jwt-stale');

    const secondFetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ token: 'jwt-fresh', expiresIn: 900 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    );
    const secondProvider = createLoroStreamsTokenProvider({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: 'raw-token',
      fetchImpl: secondFetchImpl,
      refreshSkewMs: 30_000,
    });

    await expect(secondProvider.getToken()).resolves.toBe('jwt-fresh');
    expect(secondFetchImpl).toHaveBeenCalledTimes(1);
  });
});
