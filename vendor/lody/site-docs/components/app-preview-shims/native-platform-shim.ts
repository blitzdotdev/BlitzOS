// Preview shim for `@/lib/native-platform`.
// The real module pulls in better-auth-capacitor → @capacitor/network, which can't
// resolve in the Next marketing build. The embedded product preview always runs on
// the web, so every native/iOS probe is false.
export function isNativeAppShell(): boolean {
  return false;
}

export function isIOSRuntimeEnvironment(): boolean {
  return false;
}

export function isNativeIOSAppShell(): boolean {
  return false;
}

export function shouldEnableSidebarSwipeOpenGesture(_args: unknown): boolean {
  return false;
}

export function canUseSidebarSwipeOpenGesture(): boolean {
  return false;
}
