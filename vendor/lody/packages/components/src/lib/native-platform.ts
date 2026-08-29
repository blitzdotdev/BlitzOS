const IOS_PLATFORM_PATTERN = /iPad|iPhone|iPod/;
const ANDROID_PLATFORM_PATTERN = /Android/i;

type CapacitorGlobal = {
  Capacitor?: {
    getPlatform?: () => string;
    isNativePlatform?: () => boolean;
  };
};

function isCapacitorNativePlatform(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  const capacitor = (window as unknown as CapacitorGlobal).Capacitor;
  try {
    if (capacitor?.isNativePlatform?.() === true) {
      return true;
    }
    const platform = capacitor?.getPlatform?.();
    return platform === 'ios' || platform === 'android';
  } catch {
    return false;
  }
}

export function isNativeAppShell(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  // isCapacitorNativePlatform() reads window.Capacitor.isNativePlatform() — the same
  // signal better-auth-capacitor's isNativePlatform() exposes — plus a getPlatform()
  // fallback, so it subsumes that helper without depending on auth boot to detect UI.
  const nativeWindow = window as Window & { __LODY_NATIVE__?: boolean };
  return nativeWindow.__LODY_NATIVE__ === true || isCapacitorNativePlatform();
}

export function isIOSRuntimeEnvironment(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  /* Prefer Capacitor's platform identity when we're in a native shell — it's
     the authoritative signal and won't lie even if a Capacitor plugin spoofs
     the user agent. Reading via the global avoids pulling @capacitor/core as
     a direct dep on this package. */
  const cap = (window as unknown as { Capacitor?: { getPlatform?: () => string } }).Capacitor;
  const capPlatform = cap?.getPlatform?.();
  if (capPlatform === 'ios') return true;
  if (capPlatform === 'android') return false;

  const { userAgent, platform, maxTouchPoints } = window.navigator;
  return IOS_PLATFORM_PATTERN.test(userAgent) || (platform === 'MacIntel' && maxTouchPoints > 1);
}

export function isNativeIOSAppShell(): boolean {
  return isNativeAppShell() && isIOSRuntimeEnvironment();
}

type SidebarSwipeOpenEnvironment = {
  isNativeShell: boolean;
  userAgent: string;
  platform?: string;
  maxTouchPoints?: number;
};

export function shouldEnableSidebarSwipeOpenGesture({
  isNativeShell,
  userAgent,
  platform,
  maxTouchPoints = 0,
}: SidebarSwipeOpenEnvironment): boolean {
  if (!isNativeShell) {
    return false;
  }

  const isIos =
    IOS_PLATFORM_PATTERN.test(userAgent) || (platform === 'MacIntel' && maxTouchPoints > 1);
  const isAndroid = ANDROID_PLATFORM_PATTERN.test(userAgent);

  return isIos || isAndroid;
}

export function canUseSidebarSwipeOpenGesture(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  return shouldEnableSidebarSwipeOpenGesture({
    isNativeShell: isNativeAppShell(),
    userAgent: window.navigator.userAgent,
    platform: window.navigator.platform,
    maxTouchPoints: window.navigator.maxTouchPoints,
  });
}
