import { ThemeSelectionStorageSchema, type ThemeSelectionStorage } from './vscode-theme-schemas';

export type VSCodeThemeMode = 'light' | 'dark';

export type VSCodeThemeSelection = {
  lightThemeId?: string;
  darkThemeId?: string;
};

export const DEFAULT_VSCODE_THEME_SELECTION: VSCodeThemeSelection = {
  lightThemeId: 'lody-light',
  darkThemeId: 'vesper',
};

export const parseThemeSelectionStorage = (
  value: string | null,
  fallback: VSCodeThemeSelection = DEFAULT_VSCODE_THEME_SELECTION
): VSCodeThemeSelection => {
  if (!value) {
    return fallback;
  }

  try {
    const parsed: unknown = JSON.parse(value);
    const result = ThemeSelectionStorageSchema.safeParse(parsed);
    if (!result.success) {
      return fallback;
    }
    return fromThemeSelectionStorage(result.data, fallback);
  } catch {
    return fallback;
  }
};

export const serializeThemeSelectionStorage = (selection: VSCodeThemeSelection): string =>
  JSON.stringify(toThemeSelectionStorage(selection));

const fromThemeSelectionStorage = (
  storage: ThemeSelectionStorage,
  fallback: VSCodeThemeSelection = DEFAULT_VSCODE_THEME_SELECTION
): VSCodeThemeSelection => {
  const selection = compactThemeSelection({
    lightThemeId: storage.lightThemeId,
    darkThemeId: storage.darkThemeId,
  });

  // Migrate users who previously had "Lody default colors" (undefined theme IDs).
  // If both theme IDs are missing, apply the default selection.
  if (!selection.lightThemeId && !selection.darkThemeId) {
    return fallback;
  }

  // For partial selections (one theme ID missing), fill in the missing one from defaults.
  return {
    lightThemeId: selection.lightThemeId ?? fallback.lightThemeId,
    darkThemeId: selection.darkThemeId ?? fallback.darkThemeId,
  };
};

const toThemeSelectionStorage = (selection: VSCodeThemeSelection): ThemeSelectionStorage => ({
  schemaVersion: 1,
  ...compactThemeSelection(selection),
});

export const compactThemeSelection = (selection: VSCodeThemeSelection): VSCodeThemeSelection => ({
  ...(selection.lightThemeId?.trim() ? { lightThemeId: selection.lightThemeId.trim() } : {}),
  ...(selection.darkThemeId?.trim() ? { darkThemeId: selection.darkThemeId.trim() } : {}),
});

export const updateThemeSelection = (
  selection: VSCodeThemeSelection,
  mode: VSCodeThemeMode,
  themeId: string | undefined
): VSCodeThemeSelection =>
  compactThemeSelection({
    ...selection,
    [mode === 'dark' ? 'darkThemeId' : 'lightThemeId']: themeId,
  });
