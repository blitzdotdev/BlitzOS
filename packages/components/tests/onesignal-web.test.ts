import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('posthog-js', () => ({
  default: {
    capture: vi.fn(),
  },
}));

vi.mock('@lody/shared', () => ({
  hashAnalyticsId: vi.fn(() => null),
}));

vi.mock('../src/lib/posthog-analytics', () => ({
  capturePostHogEvent: vi.fn(),
}));

type ScriptStub = HTMLScriptElement & {
  dispatch: (eventName: 'load' | 'error') => void;
  listeners: Partial<Record<'load' | 'error', EventListener>>;
  remove: ReturnType<typeof vi.fn>;
};

function createScriptStub(): ScriptStub {
  const listeners: ScriptStub['listeners'] = {};
  const script = {
    dataset: {},
    defer: false,
    src: '',
    listeners,
    addEventListener: vi.fn((eventName: 'load' | 'error', listener: EventListener) => {
      listeners[eventName] = listener;
    }),
    remove: vi.fn(),
    dispatch: (eventName: 'load' | 'error') => {
      listeners[eventName]?.(new Event(eventName));
    },
  };
  return script as unknown as ScriptStub;
}

function completeOneSignalSdk(sdk: object) {
  Object.assign(sdk, {
    login: vi.fn(),
    logout: vi.fn(),
    User: {
      setLanguage: vi.fn(),
      PushSubscription: {
        optIn: vi.fn(),
        optOut: vi.fn(),
        getOptedIn: vi.fn(async () => false),
      },
    },
    Notifications: {
      requestPermission: vi.fn(async () => true),
      getPermissionState: vi.fn(async () => 'default' as NotificationPermission),
    },
  });
}

function setWebDom({
  existingScript,
}: {
  existingScript?: HTMLScriptElement | null;
} = {}) {
  const deferred: Array<(oneSignal: unknown) => void | Promise<void>> = [];
  const documentStub = {
    head: {
      append: vi.fn(),
    },
    createElement: vi.fn(() => createScriptStub()),
    querySelector: vi.fn(() => existingScript ?? null),
  };
  const windowStub = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    setTimeout,
    clearTimeout,
    OneSignalDeferred: deferred,
    Notification: vi.fn(),
  };

  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: documentStub,
    writable: true,
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: windowStub,
    writable: true,
  });
  Object.defineProperty(globalThis, 'Notification', {
    configurable: true,
    value: vi.fn(),
    writable: true,
  });

  return { documentStub, windowStub, deferred };
}

describe('web OneSignal initialization', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { document?: unknown }).document;
    delete (globalThis as { Notification?: unknown }).Notification;
  });

  it('initializes when the deferred SDK is the static class exposed by v16', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_ONESIGNAL_APP_ID', 'test-onesignal-app-id');
    const { deferred } = setWebDom();
    const sdk = class {
      static init = vi.fn(async () => {
        completeOneSignalSdk(sdk);
      });
    };

    const { initOneSignal } = await import('../src/lib/onesignal');
    const initPromise = initOneSignal();

    expect(deferred).toHaveLength(1);
    await deferred[0]?.(sdk);

    await expect(initPromise).resolves.toBe(sdk);
    expect(sdk.init).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'test-onesignal-app-id',
        serviceWorkerPath: 'push/onesignal/OneSignalSDKWorker.js',
        serviceWorkerParam: { scope: '/push/onesignal/' },
      })
    );
  });

  it('uses the deferred queue after the page SDK has already loaded', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_ONESIGNAL_APP_ID', 'test-onesignal-app-id');
    const existingScript = createScriptStub();
    const sdk: Record<string, unknown> = {
      init: vi.fn(async () => {
        completeOneSignalSdk(sdk);
      }),
    };
    const { deferred, documentStub } = setWebDom({ existingScript });
    const loadedDeferredQueue = deferred as {
      push: (callback: (oneSignal: unknown) => void | Promise<void>) => unknown;
    };
    loadedDeferredQueue.push = vi.fn(async (callback) => callback(sdk));

    const { initOneSignal } = await import('../src/lib/onesignal');
    const oneSignal = await initOneSignal();

    expect(oneSignal).toBe(sdk);
    expect(documentStub.head.append).not.toHaveBeenCalled();
    expect(existingScript.addEventListener).toHaveBeenCalledWith(
      'error',
      expect.any(Function),
      { once: true }
    );
  });

  it('removes a failed script so the next initialization can load a fresh SDK', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_ONESIGNAL_APP_ID', 'test-onesignal-app-id');
    const failedScript = createScriptStub();
    const retryScript = createScriptStub();
    const { deferred, documentStub } = setWebDom();
    documentStub.createElement.mockReturnValueOnce(failedScript).mockReturnValueOnce(retryScript);
    const sdk = class {
      static init = vi.fn(async () => {
        completeOneSignalSdk(sdk);
      });
    };

    const { initOneSignal } = await import('../src/lib/onesignal');
    const firstInit = initOneSignal();
    failedScript.dispatch('error');

    await expect(firstInit).rejects.toThrow('Failed to load OneSignal SDK.');
    expect(failedScript.remove).toHaveBeenCalledOnce();

    const retryInit = initOneSignal();
    expect(documentStub.createElement).toHaveBeenCalledTimes(2);
    await deferred[1]?.(sdk);

    await expect(retryInit).resolves.toBe(sdk);
  });
});
