export const LODY_APP_INFO_UPDATED_EVENT = 'lody:app-info-updated';

export type LodyNativeAppInfo = NonNullable<Window['__LODY_APP_INFO__']>;

export function readNativeAppInfo(): LodyNativeAppInfo {
  if (typeof window === 'undefined') {
    return {};
  }
  return window.__LODY_APP_INFO__ ?? {};
}

export function updateNativeAppInfo(info: LodyNativeAppInfo): LodyNativeAppInfo {
  if (typeof window === 'undefined') {
    return info;
  }

  const next = {
    ...(window.__LODY_APP_INFO__ ?? {}),
    ...info,
  };
  window.__LODY_APP_INFO__ = next;
  window.dispatchEvent(new CustomEvent(LODY_APP_INFO_UPDATED_EVENT, { detail: next }));
  return next;
}
