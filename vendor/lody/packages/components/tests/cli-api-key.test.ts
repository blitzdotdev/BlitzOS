import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  generateWebCliApiKey,
  listWebCliApiKeys,
  revokeWebCliApiKey,
} from '../src/lib/cli-api-key';
import { installCloudHttpPort } from '../src/lib/cloud-http-port';

let uninstallCloudHttpPort: (() => void) | undefined;

beforeEach(() => {
  uninstallCloudHttpPort = installCloudHttpPort({
    authBaseUrl: 'https://auth.example.com',
    serverBaseUrl: null,
  });
});

afterEach(() => {
  uninstallCloudHttpPort?.();
  uninstallCloudHttpPort = undefined;
  vi.unstubAllGlobals();
});

describe('generateWebCliApiKey', () => {
  it('creates a CLI API key with the current session token', async () => {
    const fetchMock = vi.fn(async () => {
      return Response.json({
        apiKey: 'lody_token_test_key',
        apiKeyId: 'key-1',
        apiKeyStart: 'lody_token_',
        record: {
          id: 'key-1',
          name: 'Lody CLI Token',
          keyStart: 'lody_token_',
          keyPreview: 'lody_token_t******st_key',
          note: 'CI box',
          createdAt: 123,
          lastRequest: null,
          expiresAt: null,
          enabled: true,
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateWebCliApiKey({
      sessionToken: ' session-token ',
      authBaseUrl: 'https://auth.example.com/',
      note: 'CI box',
    });

    expect(result).toEqual({
      ok: true,
      apiKey: 'lody_token_test_key',
      apiKeyId: 'key-1',
      apiKeyStart: 'lody_token_',
      record: {
        id: 'key-1',
        name: 'Lody CLI Token',
        keyStart: 'lody_token_',
        keyPreview: 'lody_token_t******st_key',
        note: 'CI box',
        createdAt: 123,
        lastRequest: null,
        expiresAt: null,
        enabled: true,
      },
    });
    expect(fetchMock).toHaveBeenCalledWith('https://auth.example.com/api/cli/api-key/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer session-token',
      },
      body: JSON.stringify({ note: 'CI box', source: 'manual' }),
    });
  });

  it('returns invalid_response when the server omits the key', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ apiKeyId: 'key-1' }))
    );

    const result = await generateWebCliApiKey({
      sessionToken: 'session-token',
      authBaseUrl: 'https://auth.example.com',
    });

    expect(result).toEqual({ ok: false, error: 'invalid_response' });
  });
});

describe('listWebCliApiKeys', () => {
  it('lists persisted CLI API key records without key secrets', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          records: [
            {
              id: 'key-1',
              name: 'Lody CLI Token',
              keyStart: 'lody_token_',
              keyPreview: 'lody_token_t******st_key',
              note: 'CI box',
              createdAt: 123,
              lastRequest: null,
              expiresAt: null,
              enabled: true,
            },
          ],
        })
      )
    );

    const result = await listWebCliApiKeys({
      sessionToken: 'session-token',
      authBaseUrl: 'https://auth.example.com/',
    });

    expect(result).toEqual({
      ok: true,
      records: [
        {
          id: 'key-1',
          name: 'Lody CLI Token',
          keyStart: 'lody_token_',
          keyPreview: 'lody_token_t******st_key',
          note: 'CI box',
          createdAt: 123,
          lastRequest: null,
          expiresAt: null,
          enabled: true,
        },
      ],
    });
  });
});

describe('revokeWebCliApiKey', () => {
  it('revokes a persisted CLI API key by id', async () => {
    const fetchMock = vi.fn(async () => Response.json({ success: true }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await revokeWebCliApiKey({
      sessionToken: ' session-token ',
      authBaseUrl: 'https://auth.example.com/',
      keyId: 'key-1',
    });

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith('https://auth.example.com/api/cli/api-key/revoke', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer session-token',
      },
      body: JSON.stringify({ keyId: 'key-1' }),
    });
  });
});
