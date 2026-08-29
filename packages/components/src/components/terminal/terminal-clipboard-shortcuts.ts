import { getPlatform, isMac } from '@/lib/commands';

function isLetterKey(event: KeyboardEvent, letter: string): boolean {
  return event.code === `Key${letter.toUpperCase()}` || event.key.toLowerCase() === letter;
}

function isInsertKey(event: KeyboardEvent): boolean {
  return event.key === 'Insert' || event.code === 'Insert';
}

/** VS Code: Windows Ctrl+C copies only while a selection exists; otherwise SIGINT. */
export function isCopyShortcut(event: KeyboardEvent, hasSelection: boolean): boolean {
  if (event.type !== 'keydown' || event.altKey || !hasSelection) return false;
  if (isMac()) {
    return event.metaKey && !event.ctrlKey && !event.shiftKey && isLetterKey(event, 'c');
  }
  if (isInsertKey(event) && event.ctrlKey && !event.shiftKey && !event.metaKey) return true;
  if (event.metaKey || !event.ctrlKey || !isLetterKey(event, 'c')) return false;
  if (event.shiftKey) return true;
  return getPlatform() === 'win';
}

/** VS Code: Windows Ctrl+V; Linux Ctrl+Shift+V / Shift+Insert; macOS Cmd+V. */
export function isPasteShortcut(event: KeyboardEvent): boolean {
  if (event.type !== 'keydown' || event.altKey) return false;
  if (isMac()) {
    return event.metaKey && !event.ctrlKey && !event.shiftKey && isLetterKey(event, 'v');
  }
  if (isInsertKey(event) && event.shiftKey && !event.ctrlKey && !event.metaKey) return true;
  if (event.metaKey || !event.ctrlKey || !isLetterKey(event, 'v')) return false;
  if (event.shiftKey) return true;
  return getPlatform() === 'win';
}

/** VS Code Windows default: right-click copies+clears a selection, otherwise pastes. */
export function usesWindowsCopyPasteRightClick(): boolean {
  return getPlatform() === 'win';
}

export function copyShortcutBinding(): string {
  if (isMac()) return 'cmd+c';
  if (getPlatform() === 'win') return 'ctrl+c';
  return 'ctrl+shift+c';
}

export function pasteShortcutBinding(): string {
  if (isMac()) return 'cmd+v';
  if (getPlatform() === 'win') return 'ctrl+v';
  return 'ctrl+shift+v';
}
