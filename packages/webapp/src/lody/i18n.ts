/**
 * Lody's i18next instance, initialized with `en` only (plans/LODY-SESSIONS.md §7.5).
 *
 * Their own `@lody/components/i18n` entry loads both languages and drags in
 * OneSignal and their settings atoms, so we initialize i18next ourselves
 * against the same locale file the vendored components read. `zh_CN` stays in
 * the vendor tree, unloaded.
 */
import i18next, { type i18n } from "i18next";
import { initReactI18next } from "react-i18next";
import en from "../../../../vendor/lody/locales/en.json";

let initialized: i18n | null = null;

export function initLodyI18n(): i18n {
  if (initialized !== null) return initialized;
  void i18next.use(initReactI18next).init({
    lng: "en",
    fallbackLng: "en",
    defaultNS: "translation",
    ns: ["translation"],
    // LOAD-BEARING, and it is theirs (`components/src/i18n/index.tsx:121`).
    // `locales/en.json` is a FLAT map whose keys contain dots
    // (`"sessions.stop": "Stop"`). With i18next's default `keySeparator: '.'`
    // every one of those lookups walks a nested object that does not exist,
    // misses, and falls back to the inline default a call site happens to
    // carry — or to the raw key where it carries none. The surface still
    // renders, which is why phase 0 did not notice.
    keySeparator: false,
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
    // Also theirs: no backend is registered, so nothing may suspend on a load
    // that never happens.
    react: { useSuspense: false },
    initImmediate: false,
  });
  initialized = i18next;
  return i18next;
}
