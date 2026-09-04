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

/**
 * Strings BlitzOS overrides in Lody's own `en` bundle.
 *
 * NOT a translation layer and not a place to restyle their copy. Each entry is
 * one string the vendored bundle gets WRONG on a box, kept here rather than in
 * `vendor/lody/locales/en.json` so it is not a vendor edit — and pinned from
 * both sides by `packages/webapp/test/lody-panel-fixes.test.tsx`, which asserts
 * that the vendored string still has the defect. An upstream fix therefore
 * fails a test and this entry is deleted, instead of silently overriding a
 * string that no longer needs it.
 *
 * | Key | Row | Why |
 * |---|---|---|
 * | `sessions.fileSave.conflictDetail` | SP23-I18N | The bundle interpolates `{{conflict}}`; no call site passes one and none can — `SessionFileConflictActionRow` reads the key with no options and has no conflict to name. A member reading the save-conflict banner met the raw `{{conflict}}`. The replacement is upstream's own inline default for that key. |
 * | `sessions.fileViewer.save.withShortcut` | SP21-KEY | The Save button's tooltip advertises "(⌘S / Ctrl+S)". BlitzOS mounts neither `commands.attach(window)` nor the command palette (`v1-scope.ts`, `keyboardShortcuts`), so nothing answers that chord and the button promised a shortcut that does not exist. The title states the action alone. |
 */
export const BLITZ_LODY_EN_OVERRIDES = {
  "sessions.fileSave.conflictDetail":
    "The file changed on disk while you were editing. Choose how to reconcile.",
  "sessions.fileViewer.save.withShortcut": "Save",
} as const satisfies Record<string, string>;

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
    resources: { en: { translation: { ...en, ...BLITZ_LODY_EN_OVERRIDES } } },
    interpolation: { escapeValue: false },
    // Also theirs: no backend is registered, so nothing may suspend on a load
    // that never happens.
    react: { useSuspense: false },
    initImmediate: false,
  });
  initialized = i18next;
  return i18next;
}
