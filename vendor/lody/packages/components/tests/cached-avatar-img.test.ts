// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { useCachedAvatarSrc } from '../src/components/cached-avatar-img';
import {
  clearAvatarImageCache,
  rehydrateAvatarMemoryCacheFromPersistent,
} from '../src/lib/avatar-cache';

class CacheStorageMock {
  private stores = new Map<string, Map<string, Response>>();

  async open(name: string) {
    const store = this.stores.get(name) ?? new Map<string, Response>();
    this.stores.set(name, store);
    // Real CacheStorage matches by URL whether given a string or a Request.
    const keyOf = (key: string | { url: string }) => (typeof key === 'string' ? key : key.url);
    return {
      match: async (key: string | { url: string }) => store.get(keyOf(key))?.clone(),
      put: async (key: string, value: Response) => {
        store.set(key, value.clone());
      },
      delete: async (key: string) => store.delete(key),
      keys: async () => Array.from(store.keys()).map((url) => ({ url })),
    };
  }

  async delete(name: string) {
    return this.stores.delete(name);
  }
}

// Render the hook and record every value it returns across renders.
function mountProbe(url: string | null | undefined) {
  const values: Array<string | undefined> = [];
  function Probe({ src }: { src: string | null | undefined }) {
    values.push(useCachedAvatarSrc(src));
    return null;
  }
  const container = document.createElement('div');
  const root: Root = createRoot(container);
  return { values, root, container, render: () => createElement(Probe, { src: url }) };
}

const AVATAR_URL = 'https://avatars.githubusercontent.com/loro-dev?size=80';

describe('useCachedAvatarSrc', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;

    (window as unknown as { caches: CacheStorageMock }).caches = new CacheStorageMock();

    let counter = 0;
    Object.defineProperty(URL, 'createObjectURL', {
      value: vi.fn((blob: Blob) => `blob:${blob.size}:${(counter += 1)}`),
      configurable: true,
    });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });

    fetchMock = vi.fn(
      async () =>
        new Response(new Blob(['avatar'], { type: 'image/png' }), {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        })
    );
    Object.defineProperty(globalThis, 'fetch', {
      value: fetchMock,
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    clearAvatarImageCache();
    vi.restoreAllMocks();
  });

  it('falls back to the raw URL on first mount, then swaps to the cached blob', async () => {
    const probe = mountProbe(AVATAR_URL);
    await act(async () => {
      probe.root.render(probe.render());
    });
    await act(async () => {});

    // First paint uses the raw URL (so good network shows it immediately)...
    expect(probe.values[0]).toBe(AVATAR_URL);
    // ...then it swaps to the persisted blob once the cache load resolves.
    expect(probe.values.at(-1)).toMatch(/^blob:/);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      probe.root.unmount();
    });
  });

  it('serves the avatar from cache on the next session WITHOUT a network request', async () => {
    // First session: load + persist the blob.
    const first = mountProbe(AVATAR_URL);
    await act(async () => {
      first.root.render(first.render());
    });
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      first.root.unmount();
    });

    // New session: in-memory blob URLs are gone, persistent CacheStorage remains.
    clearAvatarImageCache({ memory: true, persistent: false });
    fetchMock.mockClear();

    const second = mountProbe(AVATAR_URL);
    await act(async () => {
      second.root.render(second.render());
    });
    await act(async () => {});

    // The avatar resolves to a blob from CacheStorage — no network needed,
    // so it paints even on a dead/poor connection. This is the fix.
    expect(second.values.at(-1)).toMatch(/^blob:/);
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => {
      second.root.unmount();
    });
  });

  it('paints the blob synchronously on first render after startup rehydrate', async () => {
    const first = mountProbe(AVATAR_URL);
    await act(async () => {
      first.root.render(first.render());
    });
    await act(async () => {});
    await act(async () => {
      first.root.unmount();
    });

    // Simulate a fresh app load: memory cleared, then warmed from persistent.
    clearAvatarImageCache({ memory: true, persistent: false });
    fetchMock.mockClear();
    await rehydrateAvatarMemoryCacheFromPersistent();

    const second = mountProbe(AVATAR_URL);
    await act(async () => {
      second.root.render(second.render());
    });

    // No raw-URL flash: the very first value is already the cached blob.
    expect(second.values[0]).toMatch(/^blob:/);
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => {
      second.root.unmount();
    });
  });
});
