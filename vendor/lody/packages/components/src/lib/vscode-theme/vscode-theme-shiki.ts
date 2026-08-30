import type { ThemeRegistrationResolved } from '@pierre/diffs';
import type { LodyResolvedVSCodeTheme, TextMateTokenColorRule } from './vscode-theme-schemas';
import { readWorkbenchColor } from './vscode-theme-color';

// Lazily import @pierre/diffs to avoid pulling in the shiki/regex/oniguruma-to-es chain
// at module load time. Those packages use lookbehind regex assertions that crash Safari < 16.4.
let registerCustomThemePromise: Promise<typeof import('@pierre/diffs')> | undefined;
function getRegisterCustomTheme() {
  if (!registerCustomThemePromise) {
    registerCustomThemePromise = import('@pierre/diffs').catch((error: unknown) => {
      registerCustomThemePromise = undefined;
      throw error;
    });
  }
  return registerCustomThemePromise;
}

// @pierre/diffs exposes registration but not deregistration. With the current bundled-theme
// integration this set remains bounded by the finite built-in theme IDs.
const registeredThemeNames = new Set<string>();
const registeringThemePromises = new Map<string, Promise<string | undefined>>();

export const DEFAULT_VSCODE_DIFF_THEME_FALLBACK = {
  dark: 'github-dark-default',
  light: 'pierre-light',
} as const;

export const createLodyVSCodeShikiThemeName = (theme: LodyResolvedVSCodeTheme): string =>
  `lody-vscode-${theme.id}`;

export const toShikiTheme = (
  theme: LodyResolvedVSCodeTheme,
  name: string = createLodyVSCodeShikiThemeName(theme)
): ThemeRegistrationResolved => {
  const foreground = readWorkbenchColor(theme, ['editor.foreground', 'foreground']) ?? '#CCCCCC';
  const background = readWorkbenchColor(theme, ['editor.background']) ?? '#1E1E1E';
  return {
    name,
    type: theme.type === 'light' || theme.type === 'hcLight' ? 'light' : 'dark',
    fg: foreground,
    bg: background,
    colors: theme.colors,
    settings: [
      {
        settings: {
          foreground,
          background,
        },
      },
      ...theme.tokenColors.map(toShikiSetting),
    ],
  };
};

export const getRegisteredLodyVSCodeThemeForDiffs = (
  theme: LodyResolvedVSCodeTheme,
  name: string = createLodyVSCodeShikiThemeName(theme)
): string | undefined => (registeredThemeNames.has(name) ? name : undefined);

export const registerLodyVSCodeThemeForDiffs = (
  theme: LodyResolvedVSCodeTheme,
  name: string = createLodyVSCodeShikiThemeName(theme)
): Promise<string | undefined> => {
  const registeredName = getRegisteredLodyVSCodeThemeForDiffs(theme, name);
  if (registeredName) {
    return Promise.resolve(registeredName);
  }

  const registeringThemePromise = registeringThemePromises.get(name);
  if (registeringThemePromise) {
    return registeringThemePromise;
  }

  const shikiTheme = toShikiTheme(theme, name);
  const promise = getRegisterCustomTheme()
    .then((m) => {
      m.registerCustomTheme(name, async () => shikiTheme);
      registeredThemeNames.add(name);
      return name;
    })
    .catch((error: unknown) => {
      // @pierre/diffs failed to load (e.g. Safari < 16.4 regex compat).
      // Theme registration is non-critical; diff viewer will use fallback themes.
      console.warn('[vscode-theme] Failed to register VSCode theme for diffs', error);
      return undefined;
    })
    .finally(() => {
      registeringThemePromises.delete(name);
    });

  registeringThemePromises.set(name, promise);
  return promise;
};

const toShikiSetting = (tokenColor: TextMateTokenColorRule) => ({
  name: tokenColor.name,
  scope: tokenColor.scope,
  settings: tokenColor.settings,
});
