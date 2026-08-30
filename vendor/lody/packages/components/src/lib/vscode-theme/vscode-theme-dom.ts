import { createThemeCssVariables } from './vscode-theme-css';
import type { LodyResolvedVSCodeTheme } from './vscode-theme-schemas';

export type VSCodeThemeCssApplication = {
  themeId: string;
  dispose: () => void;
};

type AppliedThemeRecord = {
  token: symbol;
  themeId: string;
  variableNames: string[];
};

const appliedThemeRecords = new WeakMap<HTMLElement, AppliedThemeRecord>();

export const applyVSCodeThemeCssVariables = (
  root: HTMLElement,
  theme: LodyResolvedVSCodeTheme
): VSCodeThemeCssApplication => {
  const variables = createThemeCssVariables(theme);
  const variableNames = Object.keys(variables);
  const token = Symbol(`lody-vscode-theme:${theme.id}`);
  const previous = appliedThemeRecords.get(root);

  if (previous) {
    for (const name of previous.variableNames) {
      root.style.removeProperty(name);
    }
  }

  root.dataset.lodyVscodeTheme = theme.id;
  for (const [name, value] of Object.entries(variables)) {
    root.style.setProperty(name, value);
  }
  appliedThemeRecords.set(root, { token, themeId: theme.id, variableNames });

  return {
    themeId: theme.id,
    dispose: () => {
      const current = appliedThemeRecords.get(root);
      if (current?.token === token) {
        for (const name of variableNames) {
          root.style.removeProperty(name);
        }
        appliedThemeRecords.delete(root);
      }
      if (root.dataset.lodyVscodeTheme === theme.id) {
        delete root.dataset.lodyVscodeTheme;
      }
    },
  };
};
