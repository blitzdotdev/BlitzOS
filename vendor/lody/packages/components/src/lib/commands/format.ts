import { isMac } from './platform';

const MAC_SYMBOLS: Record<string, string> = {
  $mod: '⌘',
  mod: '⌘',
  cmd: '⌘',
  command: '⌘',
  meta: '⌘',
  control: '⌃',
  ctrl: '⌃',
  alt: '⌥',
  option: '⌥',
  shift: '⇧',
  enter: '↵',
  return: '↵',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
  escape: 'esc',
  esc: 'esc',
  backspace: '⌫',
  tab: '⇥',
  space: '␣',
};

const NON_MAC_LABELS: Record<string, string> = {
  $mod: 'Ctrl',
  mod: 'Ctrl',
  cmd: 'Ctrl',
  command: 'Ctrl',
  meta: 'Win',
  control: 'Ctrl',
  ctrl: 'Ctrl',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
  enter: 'Enter',
  return: 'Enter',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
  escape: 'Esc',
  esc: 'Esc',
  backspace: 'Backspace',
  tab: 'Tab',
  space: 'Space',
};

/**
 * Convert a binding string like `$mod+shift+b` into a platform-appropriate display string.
 * macOS: `⇧⌘B`. Other: `Ctrl+Shift+B`.
 */
export function formatKeyBinding(binding: string): string {
  const mac = isMac();
  const parts = formatKeyParts(binding);
  return mac ? parts.join('') : parts.join('+');
}

/**
 * Convert a binding string into platform-appropriate per-key labels — e.g.
 * `$mod+shift+b` → `['⌘', '⇧', 'B']` on macOS, `['Ctrl', 'Shift', 'B']` elsewhere.
 *
 * Use this when rendering each key as its own visual chip (Kbd primitive).
 */
export function formatKeyParts(binding: string): string[] {
  const mac = isMac();
  const tokens = binding
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
  if (tokens.length === 0) return [];

  return tokens.map((token) => {
    const lower = token.toLowerCase();
    const fromMap = mac ? MAC_SYMBOLS[lower] : NON_MAC_LABELS[lower];
    if (fromMap) return fromMap;
    if (token.length === 1) return token.toUpperCase();
    return token;
  });
}
