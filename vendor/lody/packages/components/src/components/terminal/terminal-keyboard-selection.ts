export const KEYBOARD_SELECTION_KEYS = [
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
] as const;

export type KeyboardSelectionKey = (typeof KEYBOARD_SELECTION_KEYS)[number];

export interface CellPos {
  x: number;
  y: number;
}

export type SelectionUnit = 'cell' | 'word';

export interface KeyboardSelectionInput {
  key: KeyboardSelectionKey;
  cols: number;
  lineCount: number;
  cursor: CellPos;
  /** Inclusive start of the current shift-select session, if any. */
  anchor: CellPos | null;
  /** Exclusive head of the current shift-select session, if any. */
  head: CellPos | null;
  /** Existing xterm selection, start inclusive / end exclusive. */
  existing: { start: CellPos; end: CellPos } | null;
  unit?: SelectionUnit;
  readLine?: (y: number) => string;
}

export interface KeyboardSelectionResult {
  start: CellPos;
  length: number;
  anchor: CellPos;
  head: CellPos;
}

export function isKeyboardSelectionKey(key: string): key is KeyboardSelectionKey {
  return (KEYBOARD_SELECTION_KEYS as readonly string[]).includes(key);
}

/**
 * Windows console / VS Code intercept Shift+arrows for buffer selection.
 * xterm otherwise forwards them to the PTY as CSI sequences (`\x1b[1;2D`).
 */
export function isKeyboardSelectionShortcut(event: KeyboardEvent): boolean {
  if (event.type !== 'keydown' || !event.shiftKey || event.altKey || event.metaKey) {
    return false;
  }
  if (event.ctrlKey) {
    return event.key === 'ArrowLeft' || event.key === 'ArrowRight';
  }
  return isKeyboardSelectionKey(event.key);
}

export function selectionUnitForEvent(event: KeyboardEvent): SelectionUnit {
  return event.ctrlKey ? 'word' : 'cell';
}

export function keyboardSelectionMatchesExisting(
  anchor: CellPos | null,
  head: CellPos | null,
  existing: { start: CellPos; end: CellPos } | null,
  cols: number
): boolean {
  if (!anchor || !head || !existing) return false;
  const safeCols = Math.max(1, cols);
  const anchorOffset = toOffset(anchor, safeCols);
  const headOffset = toOffset(head, safeCols);
  return (
    toOffset(existing.start, safeCols) === Math.min(anchorOffset, headOffset) &&
    toOffset(existing.end, safeCols) === Math.max(anchorOffset, headOffset)
  );
}

export function applyKeyboardSelection(input: KeyboardSelectionInput): KeyboardSelectionResult {
  const cols = Math.max(1, input.cols);
  const lineCount = Math.max(1, input.lineCount);
  const maxExclusive = lineCount * cols;

  let anchorOffset: number;
  let headOffset: number;
  if (
    input.anchor &&
    input.head &&
    keyboardSelectionMatchesExisting(input.anchor, input.head, input.existing, cols)
  ) {
    anchorOffset = clampOffset(toOffset(input.anchor, cols), maxExclusive);
    headOffset = clampOffset(toOffset(input.head, cols), maxExclusive);
  } else if (input.existing) {
    anchorOffset = clampOffset(toOffset(input.existing.start, cols), maxExclusive);
    headOffset = clampOffset(toOffset(input.existing.end, cols), maxExclusive);
  } else {
    const cursorOffset = clampOffset(toOffset(input.cursor, cols), maxExclusive);
    anchorOffset = cursorOffset;
    headOffset = cursorOffset;
  }

  headOffset =
    input.unit === 'word' && (input.key === 'ArrowLeft' || input.key === 'ArrowRight')
      ? moveWordHead(headOffset, input.key, cols, maxExclusive, input.readLine)
      : moveExclusiveHead(headOffset, input.key, cols, maxExclusive);
  const startOffset = Math.min(anchorOffset, headOffset);
  return {
    start: fromOffset(startOffset, cols),
    length: Math.abs(headOffset - anchorOffset),
    anchor: fromOffset(anchorOffset, cols),
    head: fromOffset(headOffset, cols),
  };
}

function toOffset(pos: CellPos, cols: number): number {
  return pos.y * cols + pos.x;
}

function fromOffset(offset: number, cols: number): CellPos {
  return { x: offset % cols, y: Math.floor(offset / cols) };
}

function clampOffset(offset: number, maxExclusive: number): number {
  return Math.min(Math.max(0, offset), maxExclusive);
}

function moveExclusiveHead(
  offset: number,
  key: KeyboardSelectionKey,
  cols: number,
  maxExclusive: number
): number {
  switch (key) {
    case 'ArrowLeft':
      return clampOffset(offset - 1, maxExclusive);
    case 'ArrowRight':
      return clampOffset(offset + 1, maxExclusive);
    case 'ArrowUp':
      return clampOffset(offset - cols, maxExclusive);
    case 'ArrowDown':
      return clampOffset(offset + cols, maxExclusive);
    case 'Home':
      return Math.floor(offset / cols) * cols;
    case 'End':
      return clampOffset(Math.floor(offset / cols) * cols + cols, maxExclusive);
  }
  return offset;
}

function isWordChar(ch: string): boolean {
  return /[0-9A-Za-z_]/.test(ch);
}

function charAt(
  offset: number,
  cols: number,
  maxExclusive: number,
  readLine: ((y: number) => string) | undefined
): string {
  if (offset < 0 || offset >= maxExclusive) return ' ';
  const line = readLine?.(Math.floor(offset / cols)) ?? '';
  return line[offset % cols] ?? ' ';
}

function moveWordHead(
  offset: number,
  key: 'ArrowLeft' | 'ArrowRight',
  cols: number,
  maxExclusive: number,
  readLine: ((y: number) => string) | undefined
): number {
  if (key === 'ArrowRight') {
    let i = offset;
    if (i >= maxExclusive) return maxExclusive;
    if (isWordChar(charAt(i, cols, maxExclusive, readLine))) {
      while (i < maxExclusive && isWordChar(charAt(i, cols, maxExclusive, readLine))) i += 1;
    } else {
      while (i < maxExclusive && !isWordChar(charAt(i, cols, maxExclusive, readLine))) i += 1;
      while (i < maxExclusive && isWordChar(charAt(i, cols, maxExclusive, readLine))) i += 1;
    }
    return i;
  }

  if (offset <= 0) return 0;
  let i = offset - 1;
  if (isWordChar(charAt(i, cols, maxExclusive, readLine))) {
    while (i > 0 && isWordChar(charAt(i - 1, cols, maxExclusive, readLine))) i -= 1;
  } else {
    while (i > 0 && !isWordChar(charAt(i, cols, maxExclusive, readLine))) i -= 1;
    if (isWordChar(charAt(i, cols, maxExclusive, readLine))) {
      while (i > 0 && isWordChar(charAt(i - 1, cols, maxExclusive, readLine))) i -= 1;
    }
  }
  return i;
}
