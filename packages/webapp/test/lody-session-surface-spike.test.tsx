/**
 * Phase-0 render exit test (plans/LODY-SESSIONS.md §10, phase 0):
 * "story-grade render" of the vendored Lody leaves inside our tree.
 *
 * Mounts `SessionSurfaceSpike` — `SessionChatStreamView`, `ChatComposer` and
 * the `LoroSidebar` body — from fixture props with no daemon, no CRDT and no
 * network, and asserts each one put its fixture content in the DOM.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { SessionSurfaceSpike } from "../src/lody/SessionSurfaceSpike";
import { render, settle } from "./dom";

let cleanup: (() => Promise<void>) | null = null;

beforeAll(() => {
  // Virtua measures rows, Radix measures triggers, and the sticky-scroll hook
  // watches the viewport. jsdom ships none of these observers, and it gives
  // every element a zero box — a virtual list with a zero-height viewport
  // renders zero rows, so the stub has to report a real size.
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
  const target = globalThis as unknown as Record<string, unknown>;
  target.ResizeObserver ??= SizedResizeObserver;
  target.IntersectionObserver ??= NoopObserver;
  // virtua drops every resize entry whose target reports no `offsetParent`,
  // and jsdom reports none for anything. Without this the list measures a
  // zero viewport and renders zero rows.
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
});

afterEach(async () => {
  if (cleanup !== null) {
    await cleanup();
    cleanup = null;
  }
});

describe("vendored Lody session surface", () => {
  it("renders the chat stream, the composer, and the sidebar body from fixtures", async () => {
    const mounted = await render(<SessionSurfaceSpike />);
    cleanup = mounted.unmount;
    await settle();

    const text = mounted.container.textContent ?? "";

    // SessionChatStreamView: the user turn, the assistant answer, the folded
    // tool activity, and the edited-files card built from `fileDiff`.
    expect(text).toContain("Swap the workspace rail over to Lody session rows.");
    expect(text).toContain("The rail now renders");
    // The finished turn folded its tool activity behind a "Worked for" header,
    // which is the stream's own turn-folding contract rather than our fixture.
    expect(text).toMatch(/Worked for/);

    // ChatComposer: its textarea holds the fixture prompt and both pickers
    // rendered their selected option.
    const composer = mounted.container.querySelector("textarea");
    expect(composer).not.toBeNull();
    expect((composer as HTMLTextAreaElement).value).toContain("Move the rail over to Lody");
    expect(text).toContain("blitzdotdev/BlitzOS");

    // LoroSidebar body: session rows for both sections, and the slot we will
    // inject native Terminals rows through in phase 4 (§0.3).
    expect(text).toContain("fix the login redirect");
    expect(text).toContain("rail swap");
    expect(text).toContain("Terminals (native rows land here)");

    // Everything Lody renders stays inside the surface boundary the
    // containment test probes.
    const surface = mounted.container.querySelector(".lody-surface");
    expect(surface).not.toBeNull();
  });
});
