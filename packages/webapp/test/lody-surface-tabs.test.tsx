/**
 * Seam patch 5, pinned: host-contributed tabs in Lody's session tab strip
 * (plans/LODY-TERMINAL-TABS.md §7.1, §7.7).
 *
 * TWO KINDS OF ASSERTION, AND THEY ANSWER DIFFERENT QUESTIONS.
 *
 * 1. THE PATCH IS INERT. The whole claim that makes this seam safe to carry —
 *    and safe to upstream — is that with every new prop absent the two vendored
 *    files render byte-for-byte what upstream renders. That is checked against
 *    the real upstream source: the pinned commit is a real object in this
 *    repository (`vendor/lody/UPSTREAM.md`), so `git show` hands back the
 *    unpatched file and the diff is compared to the anchor table in
 *    `vendor/lody/BLITZ-PATCHES.md`. Every line the patch REMOVES from upstream
 *    is enumerated here; a merge that drops a hunk, or an edit that touches the
 *    vendored file anywhere undeclared, fails on the line it changed.
 * 2. THE PATCH WORKS. The real vendored `SessionTabBar` is mounted through our
 *    two hosts and driven: a contributed tab appears, selecting it reports the
 *    namespaced id, closing it reports the namespaced id, and its content is in
 *    the DOM and merely hidden while another tab is active.
 *
 * WHAT IS NOT MOUNTED HERE, AND WHY. `SessionDetail` needs a runtime, a Loro
 * document and a daemon; the suites that mount it skip wherever the daemon is
 * not installed, which is CI. So hunk 15 — the one that mounts host content
 * inside the session page — is pinned by (1) at the source, and its BEHAVIOUR
 * is pinned by (2) through `TerminalTabsHost`, which is the same composition
 * with the same rule (mounted always, `hidden` when inactive).
 */
import { act } from "react";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { SessionTabBar } from "@lody/components/components/sessions/session-tab-bar";
import { TooltipProvider } from "@lody/components/ui/tooltip";
import { initLodyI18n } from "../src/lody/i18n.js";
import { TerminalTabsHost, TerminalTabsStrip } from "../src/lody/TerminalTabsStrip.js";
import {
  SURFACE_TAB_ID_PREFIX,
  surfaceTabId,
  toSessionSurfaceTabs,
  workspaceTabIdFromSurfaceTabId,
  type SurfaceTabsBinding,
} from "../src/lody/surface-tabs.js";
import type { WebAppTabModel } from "../src/WebAppHeader.js";
import { installLodyDomStubs } from "./lody-dom-stubs.js";
import { render, settle } from "./dom.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const vendorDir = join(
  repoRoot,
  "vendor/lody/packages/components/src/components/sessions",
);
const upstreamDir = "packages/components/src/components/sessions";

/** The pin `vendor/lody/UPSTREAM.md` states, read from the file rather than
 * copied here — a stale sha in a test would compare against the wrong tree. */
function upstreamPin(): string {
  const upstream = readFileSync(join(repoRoot, "vendor/lody/UPSTREAM.md"), "utf8");
  const match = /\| Pinned commit \| `([0-9a-f]{40})` \|/u.exec(upstream);
  if (match === null) throw new Error("UPSTREAM.md no longer states a pinned commit");
  return match[1]!;
}

/** Every line the seam patch REMOVES from one vendored file, in `git diff`
 * order. This is the whole inertness statement: nothing else upstream wrote is
 * gone, so with the new props absent there is no changed branch to take. */
function removedLines(file: string): string[] {
  const pin = upstreamPin();
  const dir = mkdtempSync(join(tmpdir(), "lody-seam-"));
  const before = join(dir, "before.tsx");
  const after = join(dir, "after.tsx");
  writeFileSync(
    before,
    execFileSync("git", ["show", `${pin}:${upstreamDir}/${file}`], {
      cwd: repoRoot,
      maxBuffer: 32 * 1024 * 1024,
    }),
  );
  writeFileSync(after, readFileSync(join(vendorDir, file)));
  let diff = "";
  try {
    diff = execFileSync("git", ["diff", "--no-index", "-U0", before, after], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    // `git diff --no-index` exits 1 when the files differ, which is the only
    // interesting case; the diff itself is on stdout either way.
    const failure = error as { status?: number; stdout?: string };
    if (failure.status !== 1 || failure.stdout === undefined) throw error;
    diff = failure.stdout;
  }
  return diff
    .split("\n")
    .filter((line) => line.startsWith("-") && !line.startsWith("---"))
    .map((line) => line.slice(1));
}

describe("the vendored seam is exactly what BLITZ-PATCHES.md declares", () => {
  it("removes nothing from session-tab-bar.tsx but the six declared anchors", () => {
    expect(removedLines("session-tab-bar.tsx")).toEqual([
      // 1. the `react` import gains `type ReactNode`
      "import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';",
      // 2. `ViewerTabItem` gains `'custom'` and `icon`
      "/** A viewer tab item (file or diff) displayed in the tab bar. */",
      "  type: 'file' | 'diff';",
      // 4. `parentSession` becomes optional
      "  parentSession: SessionMeta;",
      // 3. `ViewerTabContent` draws the host's glyph
      "        {tab.type === 'file' && tab.filePath ? (",
      "        )}",
      // 5. `visibleTabIds` reads the parent id only when there is one
      "    () => (showSessionTabs ? [parentSession.id, ...sortableIds] : sortableIds),",
      "    [parentSession.id, showSessionTabs, sortableIds]",
      // 6. the parent strip item is guarded on the same thing
      "        {showSessionTabs && (",
    ]);
  });

  it("removes nothing from session-detail.tsx but seam patches 4 and 5's anchors", () => {
    expect(removedLines("session-detail.tsx")).toEqual([
      // seam patch 4's hunks are additive and remove nothing.
      // seam patch 5, hunk 7: the `react` import gains `type ReactNode`
      "import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';",
      // hunk 11: the strip's variant follows the host's list
      '      variant="session"',
      // hunk 14: an active host tab deselects the conversation surfaces
      "        const isActive = tabSession.id === activeTabSessionId;",
      "        const isActive = draft.id === activeTabSessionId;",
    ]);
  });

  it("declares the same four props on both sides of the seam", () => {
    const detail = readFileSync(join(vendorDir, "session-detail.tsx"), "utf8");
    for (const prop of [
      "surfaceTabs?: readonly SessionSurfaceTab[];",
      "activeSurfaceTabId?: string | null;",
      "onSurfaceTabSelect?: (tabId: string) => void;",
      "onSurfaceTabClose?: (tabId: string) => void;",
    ]) {
      expect(detail, `seam patch 5 declares ${prop}`).toContain(prop);
    }
    // Our side re-states the tab shape, because every `@lody/components/*`
    // specifier is `any` at the typecheck seam. The two must not drift.
    const ours = readFileSync(
      join(repoRoot, "packages/webapp/src/lody/surface-tabs.ts"),
      "utf8",
    );
    for (const field of ["id: string;", "label: string;", "icon?: ReactNode;", "content: ReactNode;"]) {
      expect(detail, `vendored SessionSurfaceTab carries ${field}`).toContain(field);
      expect(ours, `our SessionSurfaceTab carries ${field}`).toContain(field);
    }
  });
});

const i18n = initLodyI18n();

function Providers(props: { children: React.ReactNode }) {
  return (
    <I18nextProvider i18n={i18n}>
      <TooltipProvider>{props.children}</TooltipProvider>
    </I18nextProvider>
  );
}

beforeAll(() => {
  installLodyDomStubs();
});

/** The prop set `session-detail.tsx` passes today, and nothing else. */
const PRODUCTION_PROPS = {
  variant: "session" as const,
  parentSession: { id: "s-parent", title: "Parent session" },
  childSessions: [{ id: "s-child", title: "Child session" }],
  draftTabs: [],
  archivedChildSessions: [],
  activeTabSessionId: "s-parent",
  onTabSelect: () => undefined,
  onNewTab: () => undefined,
};

describe("the patched SessionTabBar with no host tabs", () => {
  it("draws today's strip, and no tab that is not a session", async () => {
    const view = await render(
      <Providers>
        <SessionTabBar {...PRODUCTION_PROPS} />
      </Providers>,
    );
    await settle();
    const tabs = [...view.container.querySelectorAll("[role='tab']")];
    expect(tabs.map((tab) => tab.id)).toEqual([
      "session-tab-s-parent",
      "session-tab-s-child",
    ]);
    expect(view.container.querySelector("[id^='viewer-tab-']")).toBeNull();
    await view.unmount();
  });
});

const TAB_MODELS: WebAppTabModel[] = [
  { id: "7", label: "claude", agent: "claude", pending: false },
  { id: "9", label: "blitz — zsh", agent: "terminal", pending: false },
];

function binding(overrides: Partial<SurfaceTabsBinding> = {}): SurfaceTabsBinding {
  return {
    tabs: toSessionSurfaceTabs(TAB_MODELS, (id) => (
      <div data-testid={`body-${id}`}>terminal {id}</div>
    )),
    activeTabId: null,
    onSelect: () => undefined,
    onClose: () => undefined,
    ...overrides,
  };
}

describe("the landing host: the same strip, with no session to root it in", () => {
  it("mounts variant='viewer' with no parentSession and draws the host's tabs", async () => {
    const view = await render(
      <Providers>
        <TerminalTabsStrip surfaceTabs={binding()} />
      </Providers>,
    );
    await settle();
    const text = view.container.textContent ?? "";
    expect(text).toContain("claude");
    expect(text).toContain("blitz — zsh");
    // No session tab, no parent tab, and no `+`: `variant="viewer"` says so,
    // and hunks 4-6 are what let a host without a session use it.
    expect(view.container.querySelector("[id^='session-tab-']")).toBeNull();
    expect(view.container.querySelector("button[aria-label='New tab']")).toBeNull();
    await view.unmount();
  });

  it("reports the NAMESPACED id on select and on close", async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const view = await render(
      <Providers>
        <TerminalTabsStrip surfaceTabs={binding({ onSelect, onClose })} />
      </Providers>,
    );
    await settle();

    const tab = view.container.querySelector<HTMLElement>("#viewer-tab-blitz-tab\\:7");
    expect(tab, "the strip draws the tab under its namespaced id").not.toBeNull();
    await act(async () => tab?.click());
    expect(onSelect).toHaveBeenCalledWith("blitz-tab:7");

    const close = tab?.querySelector<HTMLElement>("button");
    expect(close, "a host tab is closeable").not.toBeNull();
    await act(async () => close?.click());
    expect(onClose).toHaveBeenCalledWith("blitz-tab:7");
    // And the id round-trips back into what `webapp_state` and tmux key on.
    expect(workspaceTabIdFromSurfaceTabId("blitz-tab:7")).toBe("7");
    expect(workspaceTabIdFromSurfaceTabId("s-parent")).toBeNull();
    await view.unmount();
  });

  it("keeps every tab's content mounted, merely hidden, across a switch", async () => {
    const view = await render(
      <Providers>
        <TerminalTabsHost
          surfaceTabs={binding({ activeTabId: surfaceTabId("7") })}
          landing={<div data-testid="landing">landing</div>}
        />
      </Providers>,
    );
    await settle();

    // A terminal that unmounted on a tab switch would drop its WebSocket and
    // redraw from tmux on every click. Both bodies and the landing are in the
    // DOM; exactly one of the three is not hidden.
    const seven = view.container.querySelector("[data-surface-tab-id='blitz-tab:7']");
    const nine = view.container.querySelector("[data-surface-tab-id='blitz-tab:9']");
    const landing = view.container.querySelector("[data-surface-tab-id='landing']");
    expect(seven?.querySelector("[data-testid='body-7']")).not.toBeNull();
    expect(nine?.querySelector("[data-testid='body-9']")).not.toBeNull();
    expect(landing?.querySelector("[data-testid='landing']")).not.toBeNull();
    expect(seven?.className).not.toContain("hidden");
    expect(nine?.className).toContain("hidden");
    expect(landing?.className).toContain("hidden");
    await view.unmount();
  });

  it("shows the landing when no host tab is selected", async () => {
    const view = await render(
      <Providers>
        <TerminalTabsHost
          surfaceTabs={binding()}
          landing={<div data-testid="landing">landing</div>}
        />
      </Providers>,
    );
    await settle();
    const landing = view.container.querySelector("[data-surface-tab-id='landing']");
    expect(landing?.className).not.toContain("hidden");
    await view.unmount();
  });
});

describe("the id namespace", () => {
  it("cannot collide with a session id, a viewer id or a draft id", () => {
    expect(surfaceTabId(7)).toBe("blitz-tab:7");
    expect(SURFACE_TAB_ID_PREFIX).toBe("blitz-tab:");
    for (const foreign of ["s-1", "file:/a/b.ts", "diff:/a/b.ts", "draft-1", "terminal"]) {
      expect(foreign.startsWith(SURFACE_TAB_ID_PREFIX)).toBe(false);
    }
  });
});
