/**
 * The browser APIs jsdom does not implement that the vendored Lody renderer
 * needs before it will put anything in the DOM.
 *
 * Extracted from the phase-0 render test so the phase-3 mounted-surface test
 * uses the same ones: two tests disagreeing about how big a jsdom element is
 * would be two different render environments wearing one name.
 *
 * Every stub here answers ONE question — "how big is this?" — for a measuring
 * component: virtua measures rows, Radix measures triggers, and the
 * sticky-scroll hook measures the viewport. jsdom gives every element a zero
 * box, and a virtual list with a zero-height viewport renders zero rows, so a
 * test without these passes on an empty document.
 */
const VIEWPORT = { width: 1200, height: 800 };
const ROW = { width: 1200, height: 120 };

class SizedResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element): void {
    const box = target === document.scrollingElement ? VIEWPORT : ROW;
    const size = [{ inlineSize: box.width, blockSize: box.height }];
    this.callback(
      [
        {
          target,
          contentRect: { ...box, top: 0, left: 0, right: box.width, bottom: box.height, x: 0, y: 0 },
          borderBoxSize: size,
          contentBoxSize: size,
          devicePixelContentBoxSize: size,
        } as unknown as ResizeObserverEntry,
      ],
      this as unknown as ResizeObserver,
    );
  }
  unobserve(): void {}
  disconnect(): void {}
}

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] {
    return [];
  }
}

export function installLodyDomStubs(): void {
  const target = globalThis as unknown as Record<string, unknown>;
  // Monaco decides at MODULE LOAD whether the clipboard commands can be
  // registered, and jsdom implements none of `document.execCommand`. It is
  // reached from `session-monaco-text-viewer.tsx`, so any test that imports
  // the session page imports this line.
  const documentStubs = document as unknown as Record<string, unknown>;
  documentStubs.queryCommandSupported ??= () => false;
  documentStubs.execCommand ??= () => false;
  target.ResizeObserver ??= SizedResizeObserver;
  target.IntersectionObserver ??= NoopObserver;
  // virtua drops every resize entry whose target reports no `offsetParent`, and
  // jsdom reports none for anything. Without this the list measures a zero
  // viewport and renders zero rows.
  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get: () => document.body,
  });
  Element.prototype.getBoundingClientRect = function getBoundingClientRect(this: Element) {
    const box = this.clientHeight > 0 ? VIEWPORT : ROW;
    return {
      width: box.width,
      height: box.height,
      top: 0,
      left: 0,
      right: box.width,
      bottom: box.height,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  };
  Element.prototype.scrollTo ??= () => {};
  // jsdom logs "Not implemented" for the window-level one rather than throwing,
  // which turns a scroll into console noise on every render.
  window.scrollTo = () => {};
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.setPointerCapture ??= () => {};
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}
