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

const setWindow = (value: Window | undefined) => {
  // A real Window exposes addEventListener/removeEventListener. posthog-js
  // (imported transitively by onesignal.ts) registers an `online` listener on
  // `window` at module init, so these synthetic window stubs must provide them
  // or the import throws `addEventListener is not a function`.
  const withDomEvents =
    value == null
      ? value
      : (Object.assign({ addEventListener() {}, removeEventListener() {} }, value) as Window);
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: withDomEvents,
    writable: true,
  });
};

describe('native OneSignal initialization', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    setWindow(undefined);
  });

  it('uses the Cordova clobber when the plugin is exposed as window.OneSignal', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_ONESIGNAL_APP_ID', 'test-onesignal-app-id');

    const nativeOneSignal = {
      initialize: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
      User: {
        setLanguage: vi.fn(),
        pushSubscription: {
          optIn: vi.fn(),
          optOut: vi.fn(),
          getOptedInAsync: vi.fn(async () => false),
        },
      },
      Notifications: {
        requestPermission: vi.fn(async () => true),
        permissionNative: vi.fn(async () => 0),
        addEventListener: vi.fn(),
      },
    };

    const nativeWindow = {
      __LODY_CORDOVA_READY__: true,
      __LODY_NATIVE__: true,
      Capacitor: {
        getPlatform: () => 'android',
      },
      OneSignal: nativeOneSignal,
    } as unknown as Window;
    setWindow(nativeWindow);

    const { initOneSignal } = await import('../src/lib/onesignal');

    const oneSignal = await initOneSignal();

    expect(oneSignal).not.toBeNull();
    expect(nativeOneSignal.initialize).toHaveBeenCalledWith('test-onesignal-app-id');
  });

  it('does not initialize iOS Live Activities on Android', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_ONESIGNAL_APP_ID', 'test-onesignal-app-id');

    const setupOneSignalLiveActivities = vi.fn(async () => undefined);
    const nativeOneSignal = {
      initialize: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
      User: {
        setLanguage: vi.fn(),
        pushSubscription: {
          optIn: vi.fn(),
          optOut: vi.fn(),
          getOptedInAsync: vi.fn(async () => false),
        },
      },
      Notifications: {
        requestPermission: vi.fn(async () => true),
        permissionNative: vi.fn(async () => 0),
        addEventListener: vi.fn(),
      },
    };

    setWindow({
      __LODY_CORDOVA_READY__: true,
      __LODY_NATIVE__: true,
      __LODY_LIVE_ACTIVITY__: {
        setupOneSignalLiveActivities,
      },
      Capacitor: {
        getPlatform: () => 'android',
      },
      plugins: {
        OneSignal: nativeOneSignal,
      },
    } as unknown as Window);

    const { initOneSignal } = await import('../src/lib/onesignal');

    await initOneSignal();

    expect(nativeOneSignal.initialize).toHaveBeenCalledWith('test-onesignal-app-id');
    expect(setupOneSignalLiveActivities).not.toHaveBeenCalled();
  });

  it('initializes Live Activities on iOS native shells', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_ONESIGNAL_APP_ID', 'test-onesignal-app-id');

    const setupOneSignalLiveActivities = vi.fn(async () => undefined);
    const nativeOneSignal = {
      initialize: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
      User: {
        setLanguage: vi.fn(),
        pushSubscription: {
          optIn: vi.fn(),
          optOut: vi.fn(),
          getOptedInAsync: vi.fn(async () => false),
        },
      },
      Notifications: {
        requestPermission: vi.fn(async () => true),
        permissionNative: vi.fn(async () => 0),
        addEventListener: vi.fn(),
      },
    };

    setWindow({
      __LODY_CORDOVA_READY__: true,
      __LODY_NATIVE__: true,
      __LODY_LIVE_ACTIVITY__: {
        setupOneSignalLiveActivities,
      },
      Capacitor: {
        getPlatform: () => 'ios',
      },
      plugins: {
        OneSignal: nativeOneSignal,
      },
    } as unknown as Window);

    const { initOneSignal } = await import('../src/lib/onesignal');

    await initOneSignal();

    expect(nativeOneSignal.initialize).toHaveBeenCalledWith('test-onesignal-app-id');
    expect(setupOneSignalLiveActivities).toHaveBeenCalledOnce();
  });

  it('keeps native push ready when iOS Live Activity setup fails', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_ONESIGNAL_APP_ID', 'test-onesignal-app-id');

    const setupError = new Error('Live Activities unavailable');
    const setupOneSignalLiveActivities = vi.fn(async () => {
      throw setupError;
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const nativeOneSignal = {
      initialize: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
      User: {
        setLanguage: vi.fn(),
        pushSubscription: {
          optIn: vi.fn(),
          optOut: vi.fn(),
          getOptedInAsync: vi.fn(async () => false),
        },
      },
      Notifications: {
        requestPermission: vi.fn(async () => true),
        permissionNative: vi.fn(async () => 0),
        addEventListener: vi.fn(),
      },
    };

    setWindow({
      __LODY_CORDOVA_READY__: true,
      __LODY_NATIVE__: true,
      __LODY_LIVE_ACTIVITY__: {
        setupOneSignalLiveActivities,
      },
      Capacitor: {
        getPlatform: () => 'ios',
      },
      plugins: {
        OneSignal: nativeOneSignal,
      },
    } as unknown as Window);

    const { initOneSignal } = await import('../src/lib/onesignal');

    const oneSignal = await initOneSignal();

    expect(oneSignal).not.toBeNull();
    expect(nativeOneSignal.initialize).toHaveBeenCalledWith('test-onesignal-app-id');
    await vi.waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith('OneSignal Live Activity setup failed', setupError);
    });
  });
});
