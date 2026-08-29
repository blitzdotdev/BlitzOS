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
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  });
  initialized = i18next;
  return i18next;
}
