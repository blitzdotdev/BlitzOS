/**
 * Connectivity is the HOST's to report, and this is what keeps it that way.
 *
 * BlitzOS already says whether the box is reachable, once, for the whole
 * workspace: `shell/workspace-status-line.ts` builds `workspace running · box
 * unreachable` out of the gateway probe in `box-gateway-health.ts`, and the
 * shell footer renders it. The terminal, the files, the previews and the Lody
 * surface all go through that one gateway.
 *
 * The vendored surface used to say it again, in its own words and from a
 * narrower vantage: a chip reading "You are offline. Reconnect to sync." beside
 * a footer reading "workspace running", spinners for a room's catch-up, an
 * offline cloud glyph in the file viewer, a "正在重连…" pill on the mobile home.
 * Seam patch 15 takes all of it, behind one prop.
 *
 * EVERY CUT IS ASSERTED BOTH WAYS, which is `lody-v1-scope.test.tsx`'s rule and
 * the reason it is worth running: a test that only checks "the strip is absent"
 * also passes when the component stopped rendering at all, or when the state
 * that drives it was never active. So each surface is first shown ON with its
 * underlying state active — offline browser, offline machine, syncing room —
 * and only then shown dark with the suppression the host really passes.
 *
 * AND THE FOOTER IS ASSERTED TOO. Taking Lody's story away is only correct
 * while ours is still told; a change that removed both would leave a member
 * with a dead surface and no sentence anywhere. The last block is PR #155's
 * sentence, re-pinned from this side.
 *
 * WHAT IS PINNED AT THE SOURCE INSTEAD, and why. Three of seam patch 15's
 * hunks sit inside `SessionChatInterface` and `SessionDetail` — pages that pull
 * Monaco, three.js and the Loro WASM to answer whether one boolean carries one
 * extra term. `lody-panel-fixes.test.tsx` made the same call for the same
 * reason. The leaf each one feeds IS mounted here, so what a source assertion
 * covers is the wire, never the rendering.
 */
import { I18nextProvider } from "react-i18next";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionInfoBar } from "@lody/components/components/sessions/session-info-bar";
import { resolveSessionStatusStripState } from "@lody/components/components/sessions/session-status-strip";
import { MobileConnectionStatus } from "@lody/components/components/mobile/mobile-connection-status";
import { TooltipProvider } from "@lody/components/ui/tooltip";
import { initLodyI18n } from "../src/lody/i18n.js";
import { lodyV1SuppressionProps } from "../src/lody/v1-scope.js";
import { boxGatewayHealth, reportBoxGatewayProbe } from "../src/box-gateway-health.js";
import {
  workspaceStatusLine,
  WORKSPACE_UNREACHABLE_STATUS,
} from "../src/shell/workspace-status-line.js";
import { installLodyDomStubs } from "./lody-dom-stubs.js";
import { render, settle } from "./dom.js";

installLodyDomStubs();

const V1 = lodyV1SuppressionProps();

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const vendorSrc = join(repoRoot, "vendor/lody/packages/components/src");
const read = (path: string): string => readFileSync(path, "utf8");

/** The exact sentence QA row IC64 saw render inside a BlitzOS session. */
const OFFLINE_STRIP = "You are offline. Reconnect to sync.";
/** The label `SessionSyncingIndicator` draws beside its spinner (IC65). */
const SYNCING_LABEL = "Syncing";

async function renderWithI18n(element: React.ReactNode) {
  const i18n = initLodyI18n();
  const view = await render(
    <I18nextProvider i18n={i18n}>
      <TooltipProvider>{element}</TooltipProvider>
    </I18nextProvider>,
  );
  await settle();
  return view;
}

// ── 1. The resolver: two states answer the flag, one deliberately does not ──

/** A browser with no network, on a machine presence reports as offline, in a
 * workspace that still has the machine — every input the strip reads, all
 * pointing at a status. Without the flag this MUST resolve something. */
const OFFLINE_EVERYWHERE = {
  browserOnline: false,
  machineRemoved: false,
  machineOnlineStatus: "offline" as const,
  machineName: "blitz-box",
};

describe("the session status resolver separates connection from membership", () => {
  it("resolves both connection states for a host that reports nothing itself", () => {
    expect(resolveSessionStatusStripState(OFFLINE_EVERYWHERE)).toEqual({
      kind: "browser-offline",
    });
    expect(
      resolveSessionStatusStripState({ ...OFFLINE_EVERYWHERE, browserOnline: true }),
    ).toEqual({ kind: "machine-offline", machineName: "blitz-box" });
  });

  it("resolves neither of them for the host BlitzOS really is", () => {
    // The state is still ACTIVE — offline browser, offline machine. What
    // changed is who says so.
    expect(
      resolveSessionStatusStripState({
        ...OFFLINE_EVERYWHERE,
        connectionStatusHidden: V1.hideConnectionStatus,
      }),
    ).toBeNull();
    expect(
      resolveSessionStatusStripState({
        ...OFFLINE_EVERYWHERE,
        browserOnline: true,
        connectionStatusHidden: V1.hideConnectionStatus,
      }),
    ).toBeNull();
  });

  it("keeps 'machine removed', because it is not a connection and it blocks sending", () => {
    // Deliberate, and the one place this patch draws a line rather than a
    // boolean: the footer reports REACHABILITY. It says nothing about a machine
    // that no longer exists, and a member whose composer stopped working needs
    // the reason from somewhere.
    const removed = { ...OFFLINE_EVERYWHERE, browserOnline: true, machineRemoved: true };
    expect(resolveSessionStatusStripState(removed)).toEqual({ kind: "machine-removed" });
    expect(
      resolveSessionStatusStripState({
        ...removed,
        connectionStatusHidden: V1.hideConnectionStatus,
      }),
    ).toEqual({ kind: "machine-removed" });
  });
});

// ── 2. The composer status chip and the info bar's catch-up spinner ──────────

describe("the session info bar draws no connection story", () => {
  it("prints the offline sentence for a host that suppresses nothing", async () => {
    const view = await renderWithI18n(
      <SessionInfoBar status={resolveSessionStatusStripState(OFFLINE_EVERYWHERE)} />,
    );
    expect(view.container.textContent, "IC64's sentence renders without the flag").toContain(
      OFFLINE_STRIP,
    );
    await view.unmount();
  });

  it("prints nothing while the browser really is offline", async () => {
    const view = await renderWithI18n(
      <SessionInfoBar
        status={resolveSessionStatusStripState({
          ...OFFLINE_EVERYWHERE,
          connectionStatusHidden: V1.hideConnectionStatus,
        })}
      />,
    );
    expect(view.container.textContent ?? "").not.toContain(OFFLINE_STRIP);
    await view.unmount();
  });

  it("prints the machine's name for a host that suppresses nothing, and not for us", async () => {
    const on = await renderWithI18n(
      <SessionInfoBar
        status={resolveSessionStatusStripState({ ...OFFLINE_EVERYWHERE, browserOnline: true })}
      />,
    );
    expect(on.container.textContent).toContain("blitz-box is offline");
    await on.unmount();

    const off = await renderWithI18n(
      <SessionInfoBar
        status={resolveSessionStatusStripState({
          ...OFFLINE_EVERYWHERE,
          browserOnline: true,
          connectionStatusHidden: V1.hideConnectionStatus,
        })}
      />,
    );
    expect(off.container.textContent ?? "").not.toContain("offline");
    await off.unmount();
  });

  it("still explains a removed machine, with the suppression on", async () => {
    const view = await renderWithI18n(
      <SessionInfoBar
        status={resolveSessionStatusStripState({
          ...OFFLINE_EVERYWHERE,
          browserOnline: true,
          machineRemoved: true,
          connectionStatusHidden: V1.hideConnectionStatus,
        })}
      />,
    );
    expect(view.container.textContent).toContain("This machine was removed from the workspace");
    await view.unmount();
  });

  it("spins its catch-up indicator only for a host that asks for it", async () => {
    // IC65. `syncing` is the bar's whole gate for the indicator, so the two
    // renders below are the surface itself, and the source pin further down is
    // the one term that decides which of them BlitzOS gets.
    const on = await renderWithI18n(<SessionInfoBar status={null} syncing />);
    expect(on.container.textContent).toContain(SYNCING_LABEL);
    await on.unmount();

    const off = await renderWithI18n(<SessionInfoBar status={null} syncing={false} />);
    expect(off.container.textContent ?? "").not.toContain(SYNCING_LABEL);
    await off.unmount();
  });
});

// ── 3. The file viewer's status bar ─────────────────────────────────────────

describe("the file viewer's status bar keeps its save items and drops the offline glyph", () => {
  // NOT MOUNTED, and this is the one surface here that is not.
  // `session-file-content-view.tsx` imports Monaco, which decides at module load
  // whether it can register clipboard commands and reaches
  // `document.queryCommandSupported` to do it — before any statement in this
  // file can install the stub for it. `lody-panel-fixes.test.tsx` refused the
  // same import for the same reason: booting an editor to watch one glyph not
  // render would test Monaco.
  //
  // The glyph is upstream's and unchanged: `machineOfflineStatusItem` renders
  // if and only if `machineOffline` is true, and the bar filters out every null
  // item. What seam patch 15 owns is that boolean, so that boolean is what these
  // assert — with the machine's own offline state left ACTIVE in the expression.
  const view = read(join(vendorSrc, "components/sessions/session-file-content-view.tsx"));

  it("drew the glyph on the machine's state alone before this patch", () => {
    expect(view, "the item still exists, so suppressing it means something").toContain(
      "function machineOfflineStatusItem(",
    );
    expect(view).toContain("const machineItem = machineOffline === true ? machineOfflineStatusItem(t) : null;");
    expect(view).toContain(
      "const isSessionMachineOffline = !sessionMachine || sessionMachineOnlineStatus !== 'online';",
    );
  });

  it("now answers the host first, while that state is still what it was", () => {
    expect(view).toContain(
      "!hideConnectionStatus &&\n            (showProviderConnecting || shouldUseProviderFileContent) &&\n            isSessionMachineOffline",
    );
  });

  it("keeps every save and live-sync item, which are not connection state", () => {
    // The carve-out, stated as code: `Saved` / `Unsaved` / `Save failed` /
    // `Live sync delayed` are feedback about an edit the member just made. Only
    // `machineOffline` is gated; the other two arguments are untouched.
    expect(view).toContain(
      "const saveItem = showSaveStatus === true && saveStatus ? saveStatusItem(saveStatus, t) : null;",
    );
    expect(view).toContain(
      "const liveItem = showSaveStatus === true && liveStatus ? liveStatusItem(liveStatus, t) : null;",
    );
  });
});

// ── 4. The mobile home's connection banner ──────────────────────────────────

describe("the mobile home draws no connection pill", () => {
  const LABELS = { offline: "Offline", reconnecting: "Reconnecting…", loading: "Connecting…" };

  it("shows the pill for the state the atom really publishes", async () => {
    const view = await renderWithI18n(<MobileConnectionStatus state="offline" labels={LABELS} />);
    expect(view.container.textContent).toContain("Offline");
    await view.unmount();
  });

  it("shows nothing for the value our landing passes instead", async () => {
    // Seam patch 15 hunk 18 passes `undefined`, and upstream's own prop default
    // is `'online'` — the one state at which this pill renders nothing. The
    // atom keeps its value, so flipping the flag restores the banner.
    const view = await renderWithI18n(<MobileConnectionStatus state="online" labels={LABELS} />);
    expect(view.container.textContent ?? "").not.toContain("Offline");
    expect(view.container.textContent ?? "").not.toContain("Reconnecting");
    await view.unmount();
  });
});

// ── 5. The three wires a page mount would cost a minute each to prove ───────

describe("the pages carry the prop to the leaves this file mounts", () => {
  const chatInterface = read(join(vendorSrc, "components/sessions/session-chat-interface.tsx"));
  const detail = read(join(vendorSrc, "components/sessions/session-detail.tsx"));
  const landing = read(join(vendorSrc, "components/chat/chat-landing.tsx"));

  it("gates the status chip's resolver and the info bar's spinner", () => {
    expect(chatInterface).toContain("connectionStatusHidden: hideConnectionStatus,");
    expect(chatInterface).toContain(
      "syncing={!isMobile && !hideConnectionStatus && effectiveTitleSyncing}",
    );
  });

  it("gates the page header's spinner and offline glyph, unreachable though they are", () => {
    // `session-detail.tsx` mounts every chat surface with `hideHeader: true`, so
    // `SessionProjectInfo` never renders in BlitzOS. Gated anyway, so the prop
    // means one thing everywhere rather than "except in the header we skip".
    expect(detail, "the page still hides the chat surface's own header").toContain(
      "hideHeader: true,",
    );
    expect(chatInterface).toContain("isSyncing={!hideConnectionStatus && effectiveTitleSyncing}");
    expect(chatInterface).toContain("!hideConnectionStatus && sessionMachineOnlineStatus === 'offline'");
  });

  it("gates the mobile session header's spinner at the flag both readers share", () => {
    // One term, two consumers: `MobileProjectInfo`'s indicator and the
    // `titleSyncing` override the chat surface reads.
    expect(detail).toContain("!hideConnectionStatus &&\n      activeSessionTabId !== null &&");
    expect(detail).toContain("isSyncing={activeSessionDocIsSyncing}");
    expect(detail).toContain("titleSyncing={activeSessionDocIsSyncing}");
  });

  it("forwards the prop to every chat surface and every file viewer the page mounts", () => {
    expect(detail).toContain("hideConnectionStatus,");
    expect(detail).toContain("hideConnectionStatus={hideConnectionStatus}");
  });

  it("drops the landing's banner state rather than overwriting the atom", () => {
    expect(landing).toContain(
      "connectionUiState={hideConnectionStatus ? undefined : mobileHomeConnectionUiState}",
    );
  });
});

// ── 6. Ours is still told (PR #155) ─────────────────────────────────────────

describe("the BlitzOS footer still carries what Lody stopped saying", () => {
  it("says the box is unreachable while the machine runs", () => {
    expect(workspaceStatusLine("running", "unreachable")).toBe(WORKSPACE_UNREACHABLE_STATUS);
    expect(WORKSPACE_UNREACHABLE_STATUS).toContain("unreachable");
  });

  it("reaches that sentence from the probe a real outage produces", () => {
    // End to end from the same event Lody's chip used to read: the shell's own
    // box polls fail, the health settles, the sentence changes. If this stopped
    // working, suppressing the vendored chip would leave the member with no
    // report at all.
    for (let i = 0; i < 5; i += 1) reportBoxGatewayProbe("unreachable");
    expect(workspaceStatusLine("running", boxGatewayHealth())).toBe(WORKSPACE_UNREACHABLE_STATUS);
    reportBoxGatewayProbe("reached");
    expect(workspaceStatusLine("running", boxGatewayHealth())).toBe("workspace running");
  });

  it("still renders it in the shell's footer, which is the surface that replaced Lody's", () => {
    const cloudApp = read(join(repoRoot, "packages/webapp/src/CloudApp.tsx"));
    expect(cloudApp).toContain(
      "const statusWorkspace = workspaceStatusLine(activeWorkspace?.lifecycleStatus, boxGateway);",
    );
    expect(cloudApp).toContain("{statusWorkspace}");
    expect(cloudApp, "and it is announced, not merely drawn").toContain(
      '<span className="webapp-statusline__box" role="status" aria-live="polite">',
    );
  });
});
