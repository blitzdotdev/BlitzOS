import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentConfigId } from '@lody/shared';
import {
  agentDefaultsCache,
  cacheWorkspaceInfo,
  clearCachedWorkspaceInfo,
  getCachedWorkspaceId,
  getCachedWorkspaceInfo,
  persistAgentSessionDefaults,
} from '../src/lib/local-storage-cache';

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

beforeEach(() => {
  installWindowStorage();
});

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

describe('workspace info cache', () => {
  it('returns cached workspaceId after cacheWorkspaceInfo', () => {
    cacheWorkspaceInfo('alpha', 'workspace-alpha-id', 'Alpha');
    expect(getCachedWorkspaceId('alpha')).toBe('workspace-alpha-id');
  });

  it('clearCachedWorkspaceInfo only removes the targeted slug', () => {
    cacheWorkspaceInfo('alpha', 'workspace-alpha-id', 'Alpha');
    cacheWorkspaceInfo('beta', 'workspace-beta-id', 'Beta');

    clearCachedWorkspaceInfo('alpha');

    expect(getCachedWorkspaceInfo('alpha')).toBeNull();
    expect(getCachedWorkspaceInfo('beta')).toEqual({
      workspaceId: 'workspace-beta-id',
      workspaceName: 'Beta',
    });
  });

  it('clearCachedWorkspaceInfo is a no-op for unknown slugs', () => {
    cacheWorkspaceInfo('alpha', 'workspace-alpha-id', 'Alpha');
    expect(() => clearCachedWorkspaceInfo('missing')).not.toThrow();
    expect(getCachedWorkspaceId('alpha')).toBe('workspace-alpha-id');
  });
});

describe('agent session defaults cache', () => {
  it('persists mode, model, and non-empty config options per agent config', () => {
    const agentId = 'agent-config-1' as AgentConfigId;

    persistAgentSessionDefaults(agentId, {
      modeId: 'accept-edits',
      modelId: 'gpt-5',
      configOptionValues: {
        reasoning_effort: 'high',
        fast_mode: true,
      },
    });

    expect(agentDefaultsCache.get(agentId)).toEqual({
      modeId: 'accept-edits',
      modelId: 'gpt-5',
      configOptionValues: {
        reasoning_effort: 'high',
        fast_mode: true,
      },
    });
  });

  it('omits empty config options when persisting agent defaults', () => {
    const agentId = 'agent-config-2' as AgentConfigId;

    persistAgentSessionDefaults(agentId, {
      modeId: null,
      modelId: null,
      configOptionValues: {},
    });

    expect(agentDefaultsCache.get(agentId)).toEqual({
      modeId: null,
      modelId: null,
    });
  });
});
