/**
 * THE SIDE PANEL'S TAB STRIP, AND WHY A TAB LOOKED UNREACHABLE (wave 4, C3).
 *
 * The field report, from a real-Chromium audit: with four panel tabs open at the
 * side panel's default width, the first and last tabs are cut off by the frame
 * and there is no way to the rest of them.
 *
 * WHAT THIS FILE MEASURES FIRST, BECAUSE IT CORRECTS THE REPORT. The audit read
 * the tablist — `flex h-11 w-max min-w-full items-center gap-1.5` — as the whole
 * of the overflow story and concluded there is none. The tablist is not the
 * scroll container: it sits inside their `ScrollArea` with `scrollableX`, and
 * Radix puts `overflow-x: scroll` on the viewport as an INLINE style. The first
 * test renders the real vendored strip and reads that back, so the claim
 * "nothing here scrolls" cannot be repeated without a failing test, and an
 * upstream change that really does take the scroll container away fails HERE.
 *
 * WHAT IS ACTUALLY WRONG IS THE AFFORDANCE, and that is what the skin fixes.
 * Radix hides the native bar and draws its own only while the pointer is inside
 * the strip, and the strip scrolls its active tab into view with
 * `inline: 'nearest'` — which parks that tab flush against the clipped edge.
 * A strip that overflows therefore looks exactly like a strip that does not,
 * with a half tab at each end and no bar.
 *
 * WHAT NEEDS EYES, HONESTLY. jsdom runs no layout: nothing here can show that a
 * tab is clipped, or that `scroll-padding-inline` leaves its neighbour peeking
 * in. What is checkable is the DOM the rule targets, the inline style Radix
 * writes, and that the rule is in the sheet naming those hooks —
 * `lody-blitz-theme.test.ts` holds the other half, that the hooks still exist
 * upstream.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionSidePanelTabBar } from "@lody/components/components/sessions/session-side-panel-tab-bar";
import { installLodyDomStubs } from "./lody-dom-stubs";
import { render } from "./dom";

installLodyDomStubs();

const here = dirname(fileURLToPath(import.meta.url));
const skinCss = readFileSync(join(here, "..", "src", "lody", "blitz-skin.css"), "utf8");
const vendorPanel = join(
  here,
  "..",
  "..",
  "..",
  "vendor",
  "lody",
  "packages",
  "components",
  "src",
  "components",
  "sessions",
  "session-side-panel-tab-bar.tsx",
);

/** The four the audit had open: Files, All Changes, PR, Browser. */
const FOUR_PANELS = [
  { id: "files", label: "Files", kind: "files" as const },
  { id: "changes", label: "All Changes", kind: "changes" as const },
  { id: "pr", label: "PR", kind: "pr" as const },
  { id: "browser", label: "Browser", kind: "browser" as const },
];

async function renderStrip(activeTabId: string) {
  return await render(
    <SessionSidePanelTabBar
      tabs={FOUR_PANELS}
      activeTabId={activeTabId}
      onTabSelect={() => undefined}
      onTabClose={() => undefined}
      closeTabLabel={(label: string) => `Close ${label}`}
    />,
  );
}

describe("the vendored side-panel tab strip", () => {
  it("puts its tablist in a horizontal scroll container, whatever the tablist's own classes say", async () => {
    const view = await renderStrip("browser");
    const tablist = view.container.querySelector('[role="tablist"]');
    // The container the report named, unchanged — and not a scroll container.
    expect(tablist?.getAttribute("class")).toBe(
      "flex h-11 w-max min-w-full items-center gap-1.5",
    );
    const viewport = tablist?.closest("[data-radix-scroll-area-viewport]");
    expect(viewport, "the tablist is inside a Radix scroll viewport").not.toBeNull();
    // Radix's own inline style, which is where the scrolling actually lives.
    expect(viewport?.getAttribute("style")).toContain("overflow-x: scroll");
    expect(view.container.querySelectorAll('[role="tab"]')).toHaveLength(4);
    await view.unmount();
  });

  it("scrolls the selected tab into view, which is what parks one against the edge", async () => {
    // The mount effect the skin's `scroll-padding-inline` is aimed at. jsdom has
    // no `scrollIntoView`, so this records the CALL and its options rather than
    // a position — the position is the half that needs a browser.
    const calls: ScrollIntoViewOptions[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function scrollIntoViewStub(
      options?: boolean | ScrollIntoViewOptions,
    ) {
      if (typeof options === "object") calls.push(options);
    };
    try {
      const view = await renderStrip("files");
      expect(calls).toContainEqual({ block: "nearest", inline: "nearest" });
      await view.unmount();
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("gives that viewport a gutter and no scrollbar, scoped to the side panel", async () => {
    const rule =
      /\.lody-surface \[data-lody-session-tab-region="side-panel"\] \[data-radix-scroll-area-viewport\] \{([^}]*)\}/u
        .exec(skinCss)?.[1] ?? "";
    expect(rule, "the skin carries the side-panel strip rule").not.toBe("");
    // `inline: 'nearest'` reads `scroll-padding`, so this is the declaration
    // that keeps the selected tab off the clipped edge.
    expect(rule).toContain("scroll-padding-inline:");
    // Radix's own idiom, restated: `blitz-skin.css` hands every element in the
    // surface `scrollbar-width: thin`, and a native bar inside a 44px strip is a
    // third of it.
    expect(rule).toContain("scrollbar-width: none");
    expect(rule).toContain("overscroll-behavior-inline: contain");
    expect(skinCss).toContain(
      "[data-radix-scroll-area-viewport]::-webkit-scrollbar {\n  display: none;\n}",
    );
  });

  it("still finds the two vendor facts the rule depends on", () => {
    const panel = readFileSync(vendorPanel, "utf8");
    // The scroll container it hangs off.
    expect(panel).toContain("<ScrollArea");
    expect(panel).toContain("scrollableX");
    // And the effect the gutter is for.
    expect(panel).toContain("activeTabRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });");
  });
});
