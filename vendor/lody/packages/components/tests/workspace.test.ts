import { afterEach, describe, expect, it } from 'vitest';
import {
  clearPreferredWorkspaceSlug,
  getPreferredWorkspaceSlug,
  getWorkspaceSlugRuleError,
  isNavigableWorkspaceSlug,
  isUsableWorkspaceSlug,
  readPreferredWorkspaceSlug,
  writePreferredWorkspaceSlug,
} from '../src/lib/workspace';

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

describe('getPreferredWorkspaceSlug', () => {
  it('prefers active workspace over remembered workspace', () => {
    const organizations = [{ slug: 'alpha' }, { slug: 'beta' }];
    const activeOrganization = { slug: 'alpha' };

    expect(getPreferredWorkspaceSlug(activeOrganization, organizations, 'beta')).toBe('alpha');
  });

  it('falls back to remembered workspace when active workspace is missing', () => {
    const organizations = [{ slug: 'alpha' }, { slug: 'beta' }];

    expect(getPreferredWorkspaceSlug(null, organizations, 'beta')).toBe('beta');
  });

  it('falls back to first available workspace when remembered workspace is not accessible', () => {
    const organizations = [{ slug: 'alpha' }, { slug: 'beta' }];

    expect(getPreferredWorkspaceSlug(null, organizations, 'gamma')).toBe('alpha');
  });

  it('falls back to first available workspace when no active workspace exists', () => {
    const organizations = [{ slug: 'alpha' }, { slug: 'beta' }];

    expect(getPreferredWorkspaceSlug(null, organizations, null)).toBe('alpha');
  });

  it('returns null when no workspace slug is available', () => {
    expect(getPreferredWorkspaceSlug(null, [{ slug: null }], 'alpha')).toBeNull();
  });

  it('allows reserved workspace slugs when choosing existing workspaces', () => {
    const organizations = [{ slug: 'blog' }, { slug: 'beta' }];
    const activeOrganization = { slug: 'blog' };

    expect(getPreferredWorkspaceSlug(activeOrganization, organizations, 'docs')).toBe('blog');
  });

  it('allows short existing workspace slugs when choosing a workspace', () => {
    const organizations = [{ slug: 'zh' }, { slug: 'beta' }];

    expect(getPreferredWorkspaceSlug(null, organizations, 'zh')).toBe('zh');
  });
});

describe('preferred workspace storage', () => {
  it('clears the remembered workspace slug', () => {
    installWindowStorage();

    writePreferredWorkspaceSlug('alpha');
    expect(readPreferredWorkspaceSlug()).toBe('alpha');

    clearPreferredWorkspaceSlug();
    expect(readPreferredWorkspaceSlug()).toBeNull();
  });

  it('allows remembered reserved workspace slugs for navigation', () => {
    installWindowStorage();

    writePreferredWorkspaceSlug('download');

    expect(readPreferredWorkspaceSlug()).toBe('download');
  });
});

describe('workspace slug validation', () => {
  it('treats reserved workspace slugs as unavailable', () => {
    expect(getWorkspaceSlugRuleError('blog')).toBe('unavailable');
    expect(getWorkspaceSlugRuleError('Changelog')).toBe('unavailable');
    expect(getWorkspaceSlugRuleError('download')).toBe('unavailable');
    expect(getWorkspaceSlugRuleError('zh')).toBe('unavailable');
  });

  it('separates valid format from usable workspace slugs', () => {
    expect(isUsableWorkspaceSlug('my-workspace')).toBe(true);
    expect(isUsableWorkspaceSlug('docs')).toBe(false);
  });

  it('separates navigable existing workspace slugs from creatable workspace slugs', () => {
    expect(isNavigableWorkspaceSlug('zh')).toBe(true);
    expect(isUsableWorkspaceSlug('zh')).toBe(false);
  });
});
