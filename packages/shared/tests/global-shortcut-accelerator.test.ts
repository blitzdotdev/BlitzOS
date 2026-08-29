import { describe, expect, it } from 'vitest';

import {
  bindingToElectronAccelerator,
  GLOBAL_SHORTCUT_DEFAULTS,
  globalShortcutBindingHasModifier,
} from '../src/electron-ipc';

describe('bindingToElectronAccelerator', () => {
  it('converts the app-focus default', () => {
    expect(bindingToElectronAccelerator(GLOBAL_SHORTCUT_DEFAULTS['app.focus'])).toBe(
      'CommandOrControl+Shift+L'
    );
  });

  it('allows a global shortcut to be unset', () => {
    expect(bindingToElectronAccelerator(null)).toBeNull();
  });

  it('maps modifiers and uppercases letter keys', () => {
    expect(bindingToElectronAccelerator('$mod+k')).toBe('CommandOrControl+K');
    expect(bindingToElectronAccelerator('Alt+Shift+b')).toBe('Alt+Shift+B');
    expect(bindingToElectronAccelerator('Ctrl+Alt+t')).toBe('Control+Alt+T');
    expect(bindingToElectronAccelerator('cmd+1')).toBe('Command+1');
  });

  it('maps named keys', () => {
    expect(bindingToElectronAccelerator('$mod+ArrowRight')).toBe('CommandOrControl+Right');
    expect(bindingToElectronAccelerator('$mod+Space')).toBe('CommandOrControl+Space');
    expect(bindingToElectronAccelerator('$mod+Shift+F5')).toBe('CommandOrControl+Shift+F5');
  });

  it('refuses modifier-less bindings (would swallow a bare key OS-wide)', () => {
    expect(bindingToElectronAccelerator('k')).toBeNull();
    expect(bindingToElectronAccelerator('Space')).toBeNull();
    expect(bindingToElectronAccelerator('F2')).toBeNull();
  });

  it('refuses Shift-only bindings that would intercept normal typing OS-wide', () => {
    expect(bindingToElectronAccelerator('Shift+n')).toBeNull();
    expect(bindingToElectronAccelerator('Shift+1')).toBeNull();
    expect(bindingToElectronAccelerator('Shift+F2')).toBeNull();
  });

  it('refuses unknown / empty tokens', () => {
    expect(bindingToElectronAccelerator('')).toBeNull();
    expect(bindingToElectronAccelerator('Hyper+x')).toBeNull();
    expect(bindingToElectronAccelerator('$mod+Nonsense')).toBeNull();
  });

  it('dedupes repeated modifiers', () => {
    expect(bindingToElectronAccelerator('$mod+mod+k')).toBe('CommandOrControl+K');
  });
});

describe('globalShortcutBindingHasModifier', () => {
  it('detects a primary modifier', () => {
    expect(globalShortcutBindingHasModifier('$mod+Shift+n')).toBe(true);
    expect(globalShortcutBindingHasModifier('Alt+b')).toBe(true);
  });

  it('is false for a bare key or Shift-only combo', () => {
    expect(globalShortcutBindingHasModifier('n')).toBe(false);
    expect(globalShortcutBindingHasModifier('Space')).toBe(false);
    expect(globalShortcutBindingHasModifier('Shift+n')).toBe(false);
  });
});
