/**
 * The mobile mount, pinned: Lody's phone experience, scrubbed to the v1 scope.
 *
 * Both real routes used to drop the mobile branch, so `plans/LODY-V1-SCOPE.md`
 * called area 23 KILL and no scope flag had to reach a phone. The branch is
 * mounted now, and the amendment is recorded in §5 of that file.
 *
 * THREE KINDS OF ASSERTION, AND THEY ANSWER DIFFERENT QUESTIONS.
 *
 * 1. **A host tab is reachable on a phone.** The mobile tab sheet is where a
 *    phone switches tabs — there is no `SessionTabBar` on that branch at all —
 *    and seam patch 5 deliberately left it unpatched. The real vendored sheet
 *    is mounted here and driven.
 * 2. **Each scrubbed surface renders dark, and would render without the
 *    suppression.** The second half is what makes the first mean something: a
 *    test that only checks "the button is absent" also passes when the
 *    component stopped rendering at all. This is `lody-v1-scope.test.tsx`'s own
 *    rule, applied to the surfaces only a phone reaches.
 * 3. **The wiring is what it claims to be.** That the routes mount the stack,
 *    that the stack passes the props, and that the vendored files carry seam
 *    patch 16's ADDITIONS. The subsequence pin in `lody-surface-tabs.test.tsx`
 *    proves the patch removed nothing undeclared; it cannot prove what the
 *    patch added, and these are that half.
 *
 * WHAT IS NOT HERE. Mounting `SessionSurface` at 390px needs a runtime, a Loro
 * document and a daemon, so the whole-surface answer lives in the daemon-backed
 * suites that skip wherever the bundle is absent. What that mount would show is
 * decided by the three claims above plus `useIsMobile`, which is upstream's.
 */
import { I18nextProvider } from "react-i18next";
import { Provider as JotaiProvider, createStore } from "jotai";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { MobileSessionTabSheet } from "@lody/components/components/mobile/mobile-session-tab-sheet";
import { MobileHomeScreen } from "@lody/components/components/mobile/mobile-home-screen";
import { initLodyI18n } from "../src/lody/i18n.js";
import { LODY_V1_SCOPE, lodyV1SuppressionProps } from "../src/lody/v1-scope.js";
import { TerminalTabsHost } from "../src/lody/TerminalTabsStrip.js";
import type { SurfaceTabsBinding } from "../src/lody/surface-tabs.js";
import { installLodyDomStubs } from "./lody-dom-stubs.js";
import { readVendoredSource } from "./upstream-seam-pin.js";
import { render, settle } from "./dom.js";

installLodyDomStubs();

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src", "lody");
const readOurs = (file: string): string => readFileSync(join(srcDir, file), "utf8");

const V1 = lodyV1SuppressionProps();

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the vendor seam is untyped; see vendor-modules.d.ts
type AnyProps = Record<string, any>;

async function renderVendored(element: React.ReactNode) {
  const i18n = initLodyI18n();
  const view = await render(
    <I18nextProvider i18n={i18n}>
      <JotaiProvider store={createStore()}>{element}</JotaiProvider>
    </I18nextProvider>,
  );
  await settle();
  return view;
}

// ── 1. A host tab is reachable through the mobile tab sheet ─────────────────

/** One conversation and one host tab: the shape `session-detail.tsx` hands the
 * sheet once seam patch 16's `mobileViewers` hunk appends the host's list. */
const CONVERSATION: AnyProps = {
  id: "session-1",
  title: "The conversation",
  active: true,
  main: true,
  running: false,
  unread: false,
  lastActivityAt: null,
};

function sheetProps(viewers: readonly AnyProps[], onSelectViewer: () => void): AnyProps {
  return {
    open: true,
    onOpenChange: () => {},
    conversations: [CONVERSATION],
    viewers,
    onSelectConversation: () => {},
    onNewConversation: () => {},
    onSelectViewer,
  };
}

describe("a workspace terminal is reachable through the mobile tab sheet", () => {
  it("lists a host tab, with the host's own glyph, and reports the tap", async () => {
    const onSelectViewer = vi.fn();
    const view = await renderVendored(
      <MobileSessionTabSheet
        {...sheetProps(
          [
            {
              id: "blitz-tab:7",
              label: "bash",
              kind: "custom",
              active: false,
              icon: <span data-testid="host-glyph" />,
            },
          ],
          onSelectViewer,
        )}
      />,
    );
    // The sheet is a Vaul drawer and portals to the body, so the assertion
    // reads the document rather than the container.
    const row = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "bash",
    );
    expect(row, "the host tab is a row in the Viewers group").toBeDefined();
    expect(document.querySelector("[data-testid='host-glyph']")).not.toBeNull();
    row?.click();
    expect(onSelectViewer).toHaveBeenCalledWith("blitz-tab:7");
    await view.unmount();
  });

  it("draws the fallback glyph for a host tab that brought none", async () => {
    const view = await renderVendored(
      <MobileSessionTabSheet
        {...sheetProps(
          [{ id: "blitz-tab:8", label: "logs", kind: "custom", active: true }],
          () => {},
        )}
      />,
    );
    // Before seam patch 16 the kind was not in `VIEWER_ICON`, so the lookup
    // answered `undefined` and rendering the row threw. Reaching this line at
    // all is the assertion; the row is the visible half.
    const row = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "logs",
    );
    expect(row?.getAttribute("aria-current")).toBe("true");
    await view.unmount();
  });
});

// ── 2. The mobile-only surfaces the v1 scope cuts ───────────────────────────

const HOME_LABELS: AnyProps = {
  localTab: "Local",
  githubTab: "GitHub",
  projectsTab: "Projects",
  onboarding: { title: "Lody runs on your computer", action: "Download Lody" },
  settingsTab: "Settings",
};

function homeProps(overrides: AnyProps): AnyProps {
  return {
    workspace: { id: "lw_1", name: "workspace" },
    machines: [],
    selectedTab: "projects",
    localProjects: [],
    githubRepositories: [],
    chats: [],
    labels: HOME_LABELS,
    ...overrides,
  };
}

describe("the mobile home screen, scrubbed to the v1 scope", () => {
  it("offers no GitHub sub-tab without the capability, and offers one with it", async () => {
    const off = await renderVendored(
      <MobileHomeScreen {...homeProps({ showGitHubProjects: false })} />,
    );
    expect(off.container.textContent).not.toContain("GitHub");
    await off.unmount();

    const on = await renderVendored(
      <MobileHomeScreen {...homeProps({ showGitHubProjects: true })} />,
    );
    expect(on.container.textContent, "the control renders without the suppression").toContain(
      "GitHub",
    );
    await on.unmount();
  });

  it("draws no download-the-client takeover on an empty workspace, and draws one without the flag", async () => {
    // The takeover's headline is the assertion: its action button falls back to
    // the shipped i18n string when the caller supplies no label, so the title
    // is the part that is the same in every locale this mount can be in.
    const takeover = "Lody runs on your computer";
    const empty = homeProps({ selectedTab: "chat" });
    const off = await renderVendored(<MobileHomeScreen {...empty} hideOnboarding />);
    expect(off.container.textContent).not.toContain(takeover);
    await off.unmount();

    const on = await renderVendored(<MobileHomeScreen {...empty} />);
    expect(on.container.textContent, "the takeover renders without the suppression").toContain(
      takeover,
    );
    await on.unmount();
  });

  it("draws no settings gear when the host withholds the handler", async () => {
    const off = await renderVendored(<MobileHomeScreen {...homeProps({})} />);
    expect(off.container.querySelector("[aria-label='Settings']")).toBeNull();
    await off.unmount();

    const on = await renderVendored(
      <MobileHomeScreen {...homeProps({ onSettingsOpen: () => {} })} />,
    );
    expect(
      on.container.querySelector("[aria-label='Settings']"),
      "the gear renders without the suppression",
    ).not.toBeNull();
    await on.unmount();
  });
});

// ── 3. The landing host loses its strip on a phone and keeps its content ────

function binding(tabs: readonly AnyProps[]): SurfaceTabsBinding {
  return {
    // SAFETY: `SessionSurfaceTab` is the shape these literals are written in;
    // the cast is only because the vendor seam types every prop as `any`.
    tabs: tabs as never,
    activeTabId: null,
    onSelect: () => {},
    onClose: () => {},
    onDeselect: () => {},
    onSessionMissing: () => {},
  };
}

describe("the landing host on a phone", () => {
  const TABS = [
    { id: "blitz-tab:7", label: "bash", content: <div data-testid="terminal-content" /> },
  ];

  it("draws no strip, and still mounts every host tab", async () => {
    const view = await render(
      <TerminalTabsHost
        surfaceTabs={binding(TABS)}
        landing={<div data-testid="landing" />}
        showStrip={false}
      />,
    );
    expect(view.container.querySelector(".lody-terminal-tabs-strip")).toBeNull();
    expect(view.container.querySelector("[data-testid='terminal-content']")).not.toBeNull();
    expect(view.container.querySelector("[data-testid='landing']")).not.toBeNull();
    await view.unmount();
  });

  it("keeps the strip on a desktop, which is the default", async () => {
    const view = await render(
      <TerminalTabsHost surfaceTabs={binding(TABS)} landing={<div data-testid="landing" />} />,
    );
    expect(view.container.querySelector(".lody-terminal-tabs-strip")).not.toBeNull();
    await view.unmount();
  });
});

// ── 4. The wiring, read off our own sources and the vendored seam ───────────

describe("the mount is wired the way BLITZ-PATCHES.md and the scope record say", () => {
  it("carries the mobile stack on the `_auth` layout and nothing lower", () => {
    const router = readOurs("router.tsx");
    // The stack must outlive the chat -> session route change, so it hangs off
    // the route both leaves share. Mounted on a leaf it would be torn down by
    // the navigation it exists to animate.
    expect(router).toContain("component: authRouteComponent(options.readOnly === true)");
    expect(router).toContain("<MobileSessionStack workspaceName={workspaceName}");
    // Both leaves stand down on a phone, exactly as upstream's own routes do.
    expect(router).toContain("if (isMobile) return null;");
    expect(router.match(/if \(isMobile\) return null;/gu)?.length).toBe(2);
    // ChatRoute still publishes the base context: the stack reads it to keep
    // the right page beneath an open session.
    expect(router).toContain("setMobileBaseContext({");
  });

  it("asks `matchRoute` with the addresses upstream's own layout asks with", () => {
    // If either `to` were not an address our tree holds, `matchRoute` would
    // answer `false` for the life of the surface, the stack would never mount,
    // and a phone would show a blank pane — a failure with no error in it.
    // `lody-router-targets.test.ts` proves both addresses exist; this proves we
    // ask for them by upstream's own spelling, so a merge that renames one
    // fails here rather than at a member's first tap.
    const theirs = readVendoredSource("components/mobile/mobile-workspace-layout.tsx");
    const ours = readOurs("router.tsx");
    for (const address of ["/$workspaceName/chat", "/$workspaceName/sessions/$sessionId"]) {
      expect(theirs, `upstream matches on ${address}`).toContain(`matchRoute({ to: '${address}' })`);
      expect(ours, `our layout matches on ${address}`).toContain(`matchRoute({ to: "${address}" })`);
    }
  });

  it("passes every v1 suppression the two mounts need", () => {
    const stack = readOurs("MobileSessionStack.tsx");
    for (const prop of [
      "hideProductHints={V1.hideProductHints}",
      "hideAgentRoles={V1.hideAgentRoles}",
      "hideSettingsEntry={V1.hideSettingsEntry}",
      "hideConnectionStatus={V1.hideConnectionStatus}",
      "hideCloudMenuItems={V1.hideCloudMenuItems}",
      "hideNotificationPrompt={V1.hideNotificationPrompt}",
      "keyboardShortcutsAvailable={V1.keyboardShortcutsAvailable}",
      "hideLanguageServiceActions={V1.hideLanguageServiceActions}",
      "readOnly={readOnly}",
      "sideChatRequiresAssistantTurn",
    ]) {
      expect(stack, `MobileSessionStack passes ${prop}`).toContain(prop);
    }
    // The strip is the desktop affordance; the phone has Lody's own.
    expect(stack).toContain("showStrip={false}");
  });

  it("keeps every v1 flag off, and both new props derived from one", () => {
    expect(LODY_V1_SCOPE.connectionStatus).toBe(false);
    expect(V1.hideConnectionStatus).toBe(true);
    // Settings shares `cloudSurfaces` with the hint band's Go-to-settings
    // button, which is the same species of affordance.
    expect(V1.hideSettingsEntry).toBe(!LODY_V1_SCOPE.cloudSurfaces);
  });

  it("carries seam patch 16's additions in the vendored tree", () => {
    const sheet = readVendoredSource("components/mobile/mobile-session-tab-sheet.tsx");
    expect(sheet).toContain("'files' | 'custom'");
    expect(sheet, "the kind record stays total").toContain("custom: SquareDashed");
    expect(sheet, "the host's glyph wins").toContain("v.icon ?? (");

    const detail = readVendoredSource("components/sessions/session-detail.tsx");
    // The mobile chat surface forwards what `getSharedChatSurfaceProps` gives
    // the desktop one, which is defined below the mobile return.
    expect(detail).toContain("hideNotificationPrompt={hideNotificationPrompt}");
    expect(detail).toContain("hideAgentRoles={hideAgentRoles}");
    expect(detail).toContain("gitHubAvailable={githubIntegrationAvailable}");
    expect(detail).toContain("isSyncing={hideConnectionStatus ? false : activeSessionDocIsSyncing}");
    // The host tab: listed, selectable, and mounted on the mobile branch.
    expect(detail).toContain("for (const v of surfaceTabItems)");
    expect(detail).toContain("onSurfaceTabSelect?.(id)");
    expect(detail).toContain("activeMobileSurfaceTab === null");

    const landing = readVendoredSource("components/chat/chat-landing.tsx");
    expect(landing).toContain("hideConnectionStatus ? undefined : mobileHomeConnectionUiState");
    expect(landing).toContain("githubIntegrationAvailable ? handleConnectGitRepo : undefined");
    expect(landing).toContain("showGitHubProjects={githubIntegrationAvailable}");
    expect(landing).toContain("hideOnboarding={hideProductHints}");
  });
});
