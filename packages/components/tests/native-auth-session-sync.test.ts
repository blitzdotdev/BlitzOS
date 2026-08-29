import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  extractNativeAuthSessionSnapshot,
  persistNativeAuthSessionResult,
  syncNativeAuthSession,
} from '../src/lib/native-auth-session-sync';
import { readBootstrappedCurrentUser, readStoredAuthToken } from '../src/lib/auth-bootstrap';

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

const installWindowStorage = () => {
  const store = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
  };

  Object.defineProperty(globalThis, 'window', {
    value: {},
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  });
};

afterEach(() => {
  vi.restoreAllMocks();

  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, 'window');
  }

  if (originalLocalStorageDescriptor) {
    Object.defineProperty(globalThis, 'localStorage', originalLocalStorageDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

describe('native auth session sync', () => {
  it('extracts wrapped getSession results', () => {
    expect(
      extractNativeAuthSessionSnapshot({
        data: {
          session: { token: 'session-token' },
          user: { id: 'user-1' },
        },
      })
    ).toEqual({
      token: 'session-token',
      hasUser: true,
    });
  });

  it('accepts top-level tokens from sign-in responses', () => {
    expect(
      extractNativeAuthSessionSnapshot({
        data: {
          token: 'email-token',
          user: { id: 'user-1' },
        },
      })
    ).toEqual({
      token: 'email-token',
      hasUser: true,
    });
  });

  it('accepts Electron token exchange responses', () => {
    expect(
      extractNativeAuthSessionSnapshot({
        token: 'electron-token',
        user: { id: 'user-1' },
      })
    ).toEqual({
      token: 'electron-token',
      hasUser: true,
    });
  });

  it('persists the token and user bootstrap snapshot', () => {
    installWindowStorage();

    expect(
      persistNativeAuthSessionResult({
        data: {
          session: { token: 'session-token' },
          user: {
            id: 'user-1',
            email: 'ada@example.com',
            name: 'Ada',
          },
        },
      })
    ).toBe(true);

    expect(readStoredAuthToken()).toBe('session-token');
    expect(readBootstrappedCurrentUser()).toEqual({
      id: 'user-1',
      email: 'ada@example.com',
      name: 'Ada',
    });
  });

  it('uses the initial result before fetching the session', async () => {
    const getSession = vi.fn(async () => ({
      data: { session: { token: 'network-token' } },
    }));

    await expect(
      syncNativeAuthSession({
        initialResult: { data: { session: { token: 'initial-token' } } },
        getSession,
        persistSessionResult: (result) =>
          extractNativeAuthSessionSnapshot(result)?.token === 'initial-token',
      })
    ).resolves.toBe(true);

    expect(getSession).not.toHaveBeenCalled();
  });

  it('falls back to getSession when the initial result has no token', async () => {
    const getSession = vi.fn(async () => ({
      data: { session: { token: 'network-token' } },
    }));

    await expect(
      syncNativeAuthSession({
        initialResult: { data: { user: { id: 'user-1' } } },
        getSession,
        persistSessionResult: (result) =>
          extractNativeAuthSessionSnapshot(result)?.token === 'network-token',
      })
    ).resolves.toBe(true);

    expect(getSession).toHaveBeenCalledTimes(1);
  });
});
