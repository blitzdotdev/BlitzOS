import { describe, expect, it } from 'vitest';
import {
  keyboardGeometryUpdate,
} from '../src/terminal-touch-keyboard.js';
import {
  terminalCellAtPoint,
  terminalSelectionContainsCell,
  terminalSelectionChipPosition,
} from '../src/terminal-touch-selection.js';
import {
  clipboardReadDecision,
  touchGestureMoved,
  suppressCompatibilityMouse,
} from '../src/terminal-touch-gestures.js';

describe('terminal touch pure decisions', () => {
  it('tracks the tallest keyboard baseline and the existing 90px threshold', () => {
    expect(keyboardGeometryUpdate({
      baselineHeight: 800,
      keyboardUp: false,
      keyboardHideRequested: false,
      textareaFocused: true,
      geometry: { height: 709, source: 'viewport' },
    })).toEqual({
      baselineHeight: 800,
      keyboardUp: true,
      keyboardHideRequested: false,
      resetInputMode: false,
    });
    expect(keyboardGeometryUpdate({
      baselineHeight: 800,
      keyboardUp: true,
      keyboardHideRequested: false,
      textareaFocused: true,
      geometry: { height: 760, source: 'viewport' },
    })).toEqual({
      baselineHeight: 800,
      keyboardUp: false,
      keyboardHideRequested: false,
      resetInputMode: true,
    });
  });

  it('maps screen points to clamped buffer cells and positions the action chip', () => {
    const grid = {
      cols: 10,
      rows: 5,
      bufferLength: 20,
      viewportY: 8,
      rect: { left: 100, right: 300, top: 50, bottom: 150, width: 200, height: 100 },
    };
    expect(terminalCellAtPoint(299, 149, grid)).toEqual({ col: 9, row: 12 });
    expect(terminalCellAtPoint(99, 100, grid)).toBeNull();
    expect(terminalSelectionChipPosition(110, 60, {
      left: 100,
      top: 50,
      width: 300,
      height: 200,
    })).toEqual({ x: 72, y: 4 });
  });

  it('pins selection containment, movement, compatibility-tail, and clipboard outcomes', () => {
    const anchor = { start: { col: 2, row: 1 }, end: { col: 4, row: 1 } };
    expect(terminalSelectionContainsCell(anchor, { col: 4, row: 1 }, { col: 3, row: 1 }, 10))
      .toBe(true);
    expect(terminalSelectionContainsCell(anchor, { col: 4, row: 1 }, { col: 5, row: 1 }, 10))
      .toBe(false);
    expect(touchGestureMoved(0, 0, 6, 0)).toBe(false);
    expect(touchGestureMoved(0, 0, 6.01, 0)).toBe(true);
    expect(suppressCompatibilityMouse(9_000, 0, true, 10_000)).toBe(true);
    expect(suppressCompatibilityMouse(8_000, 9_000, false, 10_000)).toBe(false);
    expect(clipboardReadDecision(false, 'payload', false)).toBe('paste');
    expect(clipboardReadDecision(false, '', false)).toBe('ignore');
    expect(clipboardReadDecision(false, '', true)).toBe('hint');
    expect(clipboardReadDecision(true, 'payload', false)).toBe('ignore');
  });
});
