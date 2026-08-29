import { describe, expect, it } from 'vitest';
import {
  resolveBoardWheelScroll,
  type BoardWheelViewport,
} from '../src/components/tasks/task-board-wheel';

/** A board with room to scroll in both directions. */
const board: BoardWheelViewport = { scrollLeft: 200, scrollWidth: 2000, clientWidth: 800 };

describe('resolveBoardWheelScroll', () => {
  it('turns a wheel over the board (not a column) into board movement', () => {
    expect(resolveBoardWheelScroll({ deltaX: 0, deltaY: 120, insideColumn: false, board })).toBe(
      120
    );
    expect(resolveBoardWheelScroll({ deltaX: 0, deltaY: -120, insideColumn: false, board })).toBe(
      -120
    );
  });

  it('never remaps a wheel that starts inside a column, even at the column ends', () => {
    expect(
      resolveBoardWheelScroll({ deltaX: 0, deltaY: 120, insideColumn: true, board })
    ).toBeNull();
    expect(
      resolveBoardWheelScroll({ deltaX: 0, deltaY: -120, insideColumn: true, board })
    ).toBeNull();
  });

  it('leaves a horizontal delta alone — the browser already applies it', () => {
    expect(
      resolveBoardWheelScroll({ deltaX: -40, deltaY: 0, insideColumn: false, board })
    ).toBeNull();
    // Diagonal trackpad swipes carry both; the horizontal part is enough.
    expect(
      resolveBoardWheelScroll({ deltaX: -40, deltaY: 8, insideColumn: false, board })
    ).toBeNull();
  });

  it('releases the wheel at the ends of the board instead of trapping it', () => {
    const atRightEnd: BoardWheelViewport = {
      scrollLeft: 1200,
      scrollWidth: 2000,
      clientWidth: 800,
    };
    expect(
      resolveBoardWheelScroll({ deltaX: 0, deltaY: 120, insideColumn: false, board: atRightEnd })
    ).toBeNull();
    expect(
      resolveBoardWheelScroll({ deltaX: 0, deltaY: -120, insideColumn: false, board: atRightEnd })
    ).toBe(-120);

    const atLeftEnd: BoardWheelViewport = { scrollLeft: 0, scrollWidth: 2000, clientWidth: 800 };
    expect(
      resolveBoardWheelScroll({ deltaX: 0, deltaY: -120, insideColumn: false, board: atLeftEnd })
    ).toBeNull();
  });

  it('does nothing when the board has no horizontal overflow at all', () => {
    const noOverflow: BoardWheelViewport = { scrollLeft: 0, scrollWidth: 800, clientWidth: 800 };
    expect(
      resolveBoardWheelScroll({ deltaX: 0, deltaY: 120, insideColumn: false, board: noOverflow })
    ).toBeNull();
  });

  it('ignores sub-pixel overflow so a fractional DPR does not trap the wheel', () => {
    const hairline: BoardWheelViewport = { scrollLeft: 0, scrollWidth: 800.5, clientWidth: 800 };
    expect(
      resolveBoardWheelScroll({ deltaX: 0, deltaY: 120, insideColumn: false, board: hairline })
    ).toBeNull();
  });
});
