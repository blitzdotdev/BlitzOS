/**
 * Seam patch 19, the halves that can be driven without a daemon.
 *
 * WHAT IS MOUNTED. The real vendored `SessionSidePanelTabBar` and
 * `SessionSidePanelEmptyState`, given a `custom` option the way seam patch 19's
 * `sidePanelFixedOptions` builds one: the tab draws under its `host:` id with
 * the host's glyph (or the Files glyph when it gave none), it is offered by the
 * `+` menu and by the empty state, and selecting or closing it reports the
 * `host:` id back.
 *
 * WHAT IS NOT, AND WHY. `SessionDetail` needs a runtime, a Loro document and a
 * daemon, and `SessionBrowserPanel` / `ManagedPreviewSurface` need a session
 * doc and a preview-comment doc; the suites that mount those skip wherever the
 * daemon is not installed, which is CI. So the page-level hunks — the request
 * effect, the state report, the host body, the host viewer URL — are pinned at
 * the SOURCE by `lody-surface-tabs.test.tsx` (every line the seam removes is
 * named there, and everything else upstream wrote must survive in order), and
 * their prop surface is pinned here by name so a merge that drops one fails
 * with the prop it lost. Their behaviour is the BlitzOS integration's to prove.
 */
import { act } from "react";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  SessionSidePanelEmptyState,
  SessionSidePanelTabBar,
} from "@lody/components/components/sessions/session-side-panel-tab-bar";
import { installLodyDomStubs } from "./lody-dom-stubs.js";
import { render, settle } from "./dom.js";

installLodyDomStubs();

const here = dirname(fileURLToPath(import.meta.url));
const vendorDir = join(
  here,
  "..",
  "..",
  "..",
  "vendor/lody/packages/components/src/components/sessions",
);
const vendored = (file: string): string => readFileSync(join(vendorDir, file), "utf8");

/** The shape seam patch 19 hunk 8 pushes for each host tab, beside upstream's own two. */
const FILES = { id: "files" as const, label: "Files", kind: "files" as const };
const CHANGES = { id: "changes" as const, label: "All Changes", kind: "changes" as const };
const CONNECTIONS = {
  id: "host:connections" as const,
  label: "Connections",
  kind: "custom" as const,
  icon: <svg data-testid="host-glyph" />,
};
const BARE_HOST = { id: "host:bare" as const, label: "Bare", kind: "custom" as const };

describe("the patched SessionSidePanelTabBar with a host tab", () => {
  it("draws the host tab under its host: id, with the host's glyph", async () => {
    const view = await render(
      <SessionSidePanelTabBar
        tabs={[FILES, { ...CONNECTIONS, closeable: true }]}
        activeTabId="host:connections"
        onTabSelect={() => undefined}
        onTabClose={() => undefined}
        closeTabLabel={(label: string) => `Close ${label}`}
      />,
    );
    await settle();
    const tabs = [...view.container.querySelectorAll<HTMLElement>("[role='tab']")];
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Files", "Connections"]);
    const host = tabs[1];
    expect(host?.getAttribute("aria-selected")).toBe("true");
    expect(host?.querySelector("[data-testid='host-glyph']"), "the host's glyph").not.toBeNull();
    expect(host?.querySelector("button[aria-label='Close Connections']")).not.toBeNull();
    await view.unmount();
  });

  it("falls back to the Files glyph when the host gave no icon", async () => {
    const view = await render(
      <SessionSidePanelTabBar
        tabs={[BARE_HOST]}
        activeTabId="host:bare"
        onTabSelect={() => undefined}
        onTabClose={() => undefined}
        closeTabLabel={(label: string) => `Close ${label}`}
      />,
    );
    await settle();
    const tab = view.container.querySelector("[role='tab']");
    // lucide names every glyph it draws; `Files` is the one `SidePanelTabIcon`
    // already uses for a file without a path.
    expect(tab?.querySelector("svg.lucide-files"), "the Files glyph").not.toBeNull();
    await view.unmount();
  });

  it("reports the host: id on select and on close", async () => {
    const onTabSelect = vi.fn();
    const onTabClose = vi.fn();
    const view = await render(
      <SessionSidePanelTabBar
        tabs={[FILES, { ...CONNECTIONS, closeable: true }]}
        activeTabId="files"
        onTabSelect={onTabSelect}
        onTabClose={onTabClose}
        closeTabLabel={(label: string) => `Close ${label}`}
      />,
    );
    await settle();
    const host = [...view.container.querySelectorAll<HTMLElement>("[role='tab']")][1];
    await act(async () => host?.click());
    expect(onTabSelect).toHaveBeenCalledWith("host:connections");
    const close = host?.querySelector<HTMLElement>("button[aria-label='Close Connections']");
    await act(async () => close?.click());
    expect(onTabClose).toHaveBeenCalledWith("host:connections");
    await view.unmount();
  });

  it("offers the host tab from the empty state, under its own id", async () => {
    const onPanelOpen = vi.fn();
    const view = await render(
      <SessionSidePanelEmptyState
        panels={[FILES, CHANGES, CONNECTIONS]}
        onPanelOpen={onPanelOpen}
        title="Open a panel"
        description="Nothing is open."
      />,
    );
    await settle();
    const buttons = [...view.container.querySelectorAll<HTMLButtonElement>("button")];
    expect(buttons.map((button) => button.textContent)).toEqual([
      "Files",
      "All Changes",
      "Connections",
    ]);
    expect(buttons[2]?.querySelector("[data-testid='host-glyph']")).not.toBeNull();
    await act(async () => buttons[2]?.click());
    expect(onPanelOpen).toHaveBeenCalledWith("host:connections");
    await view.unmount();
  });

  it("enables the + menu when the host tab is the only option left", async () => {
    // Upstream disables the `+` on an empty `availablePanels`; a host tab is an
    // available panel like any other, so the button is live with one.
    const view = await render(
      <SessionSidePanelTabBar
        tabs={[FILES, CHANGES]}
        activeTabId="files"
        availablePanels={[CONNECTIONS]}
        onTabSelect={() => undefined}
        onTabClose={() => undefined}
        closeTabLabel={(label: string) => `Close ${label}`}
      />,
    );
    await settle();
    const add = view.container.querySelector<HTMLButtonElement>("button[aria-label='Add panel']");
    expect(add?.disabled).toBe(false);
    await view.unmount();
  });
});

describe("the page-level halves are declared where the pin reads them", () => {
  it("declares seam patch 19's four props and three types on SessionDetail", () => {
    const detail = vendored("session-detail.tsx");
    for (const text of [
      "export interface SessionHostSidePanelTab {",
      "export interface SessionSidePanelRequest {",
      "export interface SessionSidePanelHostState {",
      "hostSidePanelTabs?: readonly SessionHostSidePanelTab[];",
      "sidePanelRequest?: SessionSidePanelRequest | null;",
      "onSidePanelStateChange?: (state: SessionSidePanelHostState) => void;",
    ]) {
      expect(detail, `session-detail.tsx declares ${text}`).toContain(text);
    }
    // The persistence filter is the hunk whose absence corrupts stored state:
    // `persistedSidePanelTabSchema` is a `z.enum` and rejects a host id on the
    // next load, which is why it is pinned as a CALL and not only as a type.
    expect(detail).toContain("tab: isHostSidePanelTab(activeSidebarTab) ? null : activeSidebarTab,");
    expect(detail).toContain("tabs: openedSidebarTabs.filter(isPersistedSidePanelTab),");
  });
});
