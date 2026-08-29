// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ThemeProvider, useActiveVSCodeDiffThemeName } from '../src/theme-provider';
import {
  createLodyVSCodeShikiThemeName,
  getRegisteredLodyVSCodeThemeForDiffs,
  registerLodyVSCodeThemeForDiffs,
  type LodyResolvedVSCodeTheme,
} from '../src/lib/vscode-theme';

type RegisterCustomTheme = (name: string, loader: () => Promise<unknown>) => void;

const mocks = vi.hoisted(() => ({
  registerCustomTheme: vi.fn<RegisterCustomTheme>(),
}));

vi.mock('@pierre/diffs', () => mocks);

const createTheme = (id: string): LodyResolvedVSCodeTheme => ({
  schemaVersion: 1,
  id,
  label: `Theme ${id}`,
  type: 'dark',
  source: { kind: 'test-fixture' },
  colors: {
    'editor.background': '#101010',
    'editor.foreground': '#FFFFFF',
  },
  tokenColors: [
    {
      scope: 'keyword',
      settings: { foreground: '#FFC799' },
    },
  ],
});

function DiffThemeProbe() {
  const diffThemeName = useActiveVSCodeDiffThemeName();
  return createElement('div', {
    id: 'diff-theme-probe',
    'data-diff-theme-name': diffThemeName ?? '',
  });
}

const waitForMacrotask = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('VSCode diff theme registration', () => {
  beforeEach(() => {
    mocks.registerCustomTheme.mockClear();
  });

  it('does not report a lazy custom theme as registered until @pierre/diffs has the loader', async () => {
    const theme = createTheme('registration-race');
    const themeName = createLodyVSCodeShikiThemeName(theme);

    const firstRegistration = registerLodyVSCodeThemeForDiffs(theme);
    const secondRegistration = registerLodyVSCodeThemeForDiffs(theme);

    expect(firstRegistration).toBe(secondRegistration);
    expect(getRegisteredLodyVSCodeThemeForDiffs(theme)).toBeUndefined();
    expect(mocks.registerCustomTheme).not.toHaveBeenCalled();

    await expect(firstRegistration).resolves.toBe(themeName);
    await expect(secondRegistration).resolves.toBe(themeName);

    expect(getRegisteredLodyVSCodeThemeForDiffs(theme)).toBe(themeName);
    expect(mocks.registerCustomTheme).toHaveBeenCalledTimes(1);

    const registrationCall = mocks.registerCustomTheme.mock.calls[0];
    expect(registrationCall?.[0]).toBe(themeName);
    const loader = registrationCall?.[1];
    if (!loader) {
      throw new Error('Expected custom theme loader to be registered.');
    }
    await expect(loader()).resolves.toMatchObject({ name: themeName });
  });

  it('keeps the React hook on fallback until the lazy custom theme registration finishes', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    let root: Root | undefined = createRoot(container);

    try {
      flushSync(() => {
        root?.render(
          createElement(
            ThemeProvider,
            {
              defaultTheme: 'dark',
              storageKey: 'diff-theme-registration-test-theme',
            },
            createElement(DiffThemeProbe)
          )
        );
      });

      const probe = container.querySelector<HTMLElement>('#diff-theme-probe');
      expect(probe?.dataset.diffThemeName).toBe('');

      for (let attempts = 0; attempts < 10; attempts += 1) {
        await waitForMacrotask();
        if (probe?.dataset.diffThemeName === 'lody-vscode-vesper') {
          break;
        }
      }

      expect(probe?.dataset.diffThemeName).toBe('lody-vscode-vesper');
    } finally {
      flushSync(() => {
        root?.unmount();
      });
      root = undefined;
      container.remove();
      window.localStorage.clear();
    }
  });
});
