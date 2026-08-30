import { describe, expect, it } from 'vitest';

import {
  applyKeyboardSelection,
  isKeyboardSelectionShortcut,
} from '../src/components/terminal/terminal-keyboard-selection';

function select(input: Parameters<typeof applyKeyboardSelection>[0]) {
  return applyKeyboardSelection(input);
}

describe('applyKeyboardSelection', () => {
  it('starts from the cursor and extends one cell to the right', () => {
    expect(
      select({
        key: 'ArrowRight',
        cols: 80,
        lineCount: 24,
        cursor: { x: 5, y: 2 },
        anchor: null,
        head: null,
        existing: null,
      })
    ).toEqual({
      start: { x: 5, y: 2 },
      length: 1,
      anchor: { x: 5, y: 2 },
      head: { x: 6, y: 2 },
    });
  });

  it('extends backward from the cursor', () => {
    expect(
      select({
        key: 'ArrowLeft',
        cols: 80,
        lineCount: 24,
        cursor: { x: 5, y: 2 },
        anchor: null,
        head: null,
        existing: null,
      })
    ).toEqual({
      start: { x: 4, y: 2 },
      length: 1,
      anchor: { x: 5, y: 2 },
      head: { x: 4, y: 2 },
    });
  });

  it('keeps the original anchor across later moves', () => {
    expect(
      select({
        key: 'ArrowRight',
        cols: 80,
        lineCount: 24,
        cursor: { x: 5, y: 2 },
        anchor: { x: 5, y: 2 },
        head: { x: 8, y: 2 },
        existing: { start: { x: 5, y: 2 }, end: { x: 8, y: 2 } },
      })
    ).toEqual({
      start: { x: 5, y: 2 },
      length: 4,
      anchor: { x: 5, y: 2 },
      head: { x: 9, y: 2 },
    });
  });

  it('wraps across a line boundary', () => {
    expect(
      select({
        key: 'ArrowRight',
        cols: 10,
        lineCount: 24,
        cursor: { x: 9, y: 2 },
        anchor: { x: 9, y: 2 },
        head: { x: 9, y: 2 },
        existing: null,
      })
    ).toEqual({
      start: { x: 9, y: 2 },
      length: 1,
      anchor: { x: 9, y: 2 },
      head: { x: 0, y: 3 },
    });
  });

  it('extends a full line with Shift+End', () => {
    expect(
      select({
        key: 'End',
        cols: 10,
        lineCount: 24,
        cursor: { x: 3, y: 1 },
        anchor: null,
        head: null,
        existing: null,
      })
    ).toEqual({
      start: { x: 3, y: 1 },
      length: 7,
      anchor: { x: 3, y: 1 },
      head: { x: 0, y: 2 },
    });
  });

  it('extends by word with Ctrl+Shift+Right', () => {
    const line = 'hello world';
    expect(
      select({
        key: 'ArrowRight',
        cols: 20,
        lineCount: 1,
        cursor: { x: 0, y: 0 },
        anchor: null,
        head: null,
        existing: null,
        unit: 'word',
        readLine: () => line,
      })
    ).toEqual({
      start: { x: 0, y: 0 },
      length: 5,
      anchor: { x: 0, y: 0 },
      head: { x: 5, y: 0 },
    });
  });

  it('ignores a stale keyboard session when the xterm selection moved', () => {
    expect(
      select({
        key: 'ArrowRight',
        cols: 80,
        lineCount: 24,
        cursor: { x: 0, y: 10 },
        anchor: { x: 5, y: 2 },
        head: { x: 8, y: 2 },
        existing: { start: { x: 10, y: 5 }, end: { x: 14, y: 5 } },
      })
    ).toEqual({
      start: { x: 10, y: 5 },
      length: 5,
      anchor: { x: 10, y: 5 },
      head: { x: 15, y: 5 },
    });
  });

  it('starts from the cursor when a cached session no longer has an xterm selection', () => {
    expect(
      select({
        key: 'ArrowRight',
        cols: 80,
        lineCount: 24,
        cursor: { x: 3, y: 7 },
        anchor: { x: 5, y: 2 },
        head: { x: 8, y: 2 },
        existing: null,
      })
    ).toEqual({
      start: { x: 3, y: 7 },
      length: 1,
      anchor: { x: 3, y: 7 },
      head: { x: 4, y: 7 },
    });
  });

  it('keeps the keyboard anchor when the xterm selection still matches the session', () => {
    expect(
      select({
        key: 'ArrowLeft',
        cols: 80,
        lineCount: 24,
        cursor: { x: 0, y: 10 },
        anchor: { x: 8, y: 2 },
        head: { x: 5, y: 2 },
        existing: { start: { x: 5, y: 2 }, end: { x: 8, y: 2 } },
      })
    ).toEqual({
      start: { x: 4, y: 2 },
      length: 4,
      anchor: { x: 8, y: 2 },
      head: { x: 4, y: 2 },
    });
  });

  it('uses an existing xterm selection when the session has no stored anchor', () => {
    expect(
      select({
        key: 'ArrowDown',
        cols: 80,
        lineCount: 24,
        cursor: { x: 0, y: 10 },
        anchor: null,
        head: null,
        existing: { start: { x: 2, y: 1 }, end: { x: 6, y: 1 } },
      })
    ).toEqual({
      start: { x: 2, y: 1 },
      length: 84,
      anchor: { x: 2, y: 1 },
      head: { x: 6, y: 2 },
    });
  });
});

function keyEvent(init: Partial<KeyboardEvent> & Pick<KeyboardEvent, 'key'>): KeyboardEvent {
  return {
    type: 'keydown',
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ctrlKey: false,
    ...init,
  } as KeyboardEvent;
}

describe('isKeyboardSelectionShortcut', () => {
  it('matches Shift+arrows and ignores Ctrl/Alt/Meta chords', () => {
    expect(isKeyboardSelectionShortcut(keyEvent({ key: 'ArrowLeft', shiftKey: true }))).toBe(true);
    expect(isKeyboardSelectionShortcut(keyEvent({ key: 'ArrowLeft' }))).toBe(false);
    expect(
      isKeyboardSelectionShortcut(keyEvent({ key: 'ArrowLeft', shiftKey: true, ctrlKey: true }))
    ).toBe(true);
    expect(
      isKeyboardSelectionShortcut(keyEvent({ key: 'Home', shiftKey: true, ctrlKey: true }))
    ).toBe(false);
    expect(isKeyboardSelectionShortcut(keyEvent({ key: 'Home', shiftKey: true }))).toBe(true);
  });
});
