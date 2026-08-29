import { describe, expect, it } from 'vitest';
import {
  NO_SCROLL_EDGE_OVERFLOW,
  buildScrollEdgeFadeMask,
  readScrollEdgeOverflow,
  scrollEdgeOverflowEquals,
} from '../src/lib/scroll-edge-fade';

const strip = (scrollTop: number, clientHeight = 100, scrollHeight = 300) => ({
  scrollTop,
  clientHeight,
  scrollHeight,
});

describe('readScrollEdgeOverflow', () => {
  it('reports only the bottom at the start of a scrollable strip', () => {
    expect(readScrollEdgeOverflow(strip(0))).toEqual({ top: false, bottom: true });
  });

  it('reports both in the middle', () => {
    expect(readScrollEdgeOverflow(strip(100))).toEqual({ top: true, bottom: true });
  });

  it('reports only the top at the end', () => {
    expect(readScrollEdgeOverflow(strip(200))).toEqual({ top: true, bottom: false });
  });

  it('reports neither when the content fits', () => {
    expect(readScrollEdgeOverflow(strip(0, 300, 300))).toEqual(NO_SCROLL_EDGE_OVERFLOW);
  });

  it('ignores sub-pixel offsets at either end', () => {
    // Fractional scroll positions are routine on HiDPI; treating them as
    // overflow would fade an edge that has nothing past it.
    expect(readScrollEdgeOverflow(strip(0.5))).toEqual({ top: false, bottom: true });
    expect(readScrollEdgeOverflow(strip(199.5))).toEqual({ top: true, bottom: false });
  });
});

describe('scrollEdgeOverflowEquals', () => {
  it('lets a caller keep its previous state object when nothing changed', () => {
    expect(
      scrollEdgeOverflowEquals({ top: true, bottom: false }, { top: true, bottom: false })
    ).toBe(true);
    expect(
      scrollEdgeOverflowEquals({ top: true, bottom: false }, { top: true, bottom: true })
    ).toBe(false);
  });
});

describe('buildScrollEdgeFadeMask', () => {
  it('applies no mask when neither edge has content beyond it', () => {
    // Also the not-scrollable case, so a short list pays for no mask and no
    // extra compositing layer.
    expect(buildScrollEdgeFadeMask(NO_SCROLL_EDGE_OVERFLOW, 24)).toBeUndefined();
  });

  // An edge with nothing past it gets a ZERO-LENGTH stop rather than being
  // omitted — `#000 100%, transparent 100%` paints no visible fade — so these
  // assert the stop positions, not the presence of a colour.
  it('fades only the top when the strip is scrolled to its end', () => {
    const mask = buildScrollEdgeFadeMask({ top: true, bottom: false }, 24);
    expect(mask).toContain('#000 24px');
    expect(mask).toContain('#000 100%');
    expect(mask).not.toContain('calc(');
  });

  it('fades only the bottom when the strip is at its start', () => {
    const mask = buildScrollEdgeFadeMask({ top: false, bottom: true }, 24);
    expect(mask).toContain('#000 0,');
    expect(mask).toContain('calc(100% - 24px)');
    expect(mask).not.toContain('#000 24px');
  });

  it('fades both edges in the middle of a long strip', () => {
    const mask = buildScrollEdgeFadeMask({ top: true, bottom: true }, 24);
    expect(mask).toContain('#000 24px');
    expect(mask).toContain('calc(100% - 24px)');
  });

  it('takes the fade length from its caller, since surfaces differ', () => {
    expect(buildScrollEdgeFadeMask({ top: true, bottom: false }, 56)).toContain('#000 56px');
  });
});
