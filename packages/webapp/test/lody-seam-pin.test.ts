/**
 * The seam pin: every vendored file BlitzOS patches, against pristine upstream.
 *
 * WHY THIS IS ITS OWN FILE, AND IT IS NOT TIDINESS. These assertions read seven
 * text files off disk and import nothing. They used to live in
 * `lody-surface-tabs.test.tsx`, whose file-level `beforeAll` imports the route
 * tree — Monaco, shiki, three, the Loro WASM — and that import is the slowest
 * thing in the suite. When the machine is loaded it exceeds the hook budget,
 * and vitest then reports EVERY test in the file as skipped, the pin included.
 * A check that is meant to fail loudly on an undeclared vendor edit must not be
 * the first thing a slow machine turns off, so it now costs five `readFileSync`
 * calls and nothing else.
 *
 * TWO KINDS OF CLAIM.
 *
 * 1. THE PATCHES ARE INERT. With every new prop absent, each patched file
 *    renders byte-for-byte what upstream renders. `expectSeam` proves it: each
 *    declared anchor is the line upstream really has at that number, and
 *    upstream MINUS those lines is still a subsequence of the patched file. See
 *    `upstream-seam-pin.ts` for the mechanics and `upstream-baseline/README.md`
 *    for the baselines' provenance.
 * 2. THE DECLARATIONS AGREE. The props seam patch 5 states on both sides of the
 *    vendor boundary, and the writers seam patch 5 hunk 17 routes through the
 *    announcing setter.
 *
 * The BEHAVIOUR of each patch is pinned where it can be driven:
 * `lody-surface-tabs.test.tsx` mounts the real `SessionTabBar` through both
 * hosts, and `lody-mobile-mount.test.tsx` mounts the real mobile tab sheet and
 * the real mobile home screen.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  expectSeam as expectSeamAgainstBaseline,
  type SeamAnchor,
} from "./upstream-seam-pin.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const vendorDir = join(repoRoot, "vendor/lody/packages/components/src/components/sessions");
const baselineDir = join(here, "upstream-baseline");

/** Paths in `upstream-seam-pin.ts` are relative to the components `src`; the
 * two files this suite anchors by name live under `components/sessions`. */
const expectSeam = (file: string, anchors: readonly SeamAnchor[]): void =>
  expectSeamAgainstBaseline(`components/sessions/${file}`, anchors);

describe("the vendored seam is exactly what BLITZ-PATCHES.md declares", () => {
  it("only adds the declared ACP authentication lane to message-processor.ts", () => {
    expectSeamAgainstBaseline("lib/message-processor.ts", [], "cli");
    const processor = readFileSync(
      join(repoRoot, "vendor/lody/apps/cli/src/lib/message-processor.ts"),
      "utf8",
    );
    expect(processor).toContain("case 'machine/acp-authenticate':");
    expect(processor).toContain(
      "return message.action === 'start' ? `acp-auth:${message.configId}` : null;",
    );
  });

  it("pins the opt-in MCP and cgroup seams selected by the box service", () => {
    expectSeamAgainstBaseline("agent/agent-client.ts", [
      [777, "      const message = `Workspace MCP servers could not be loaded (${formatErrorMessage("],
      [778, "        error"],
      [779, "      )}). The agent started with only the built-in Lody server.`;"],
    ], "cli");
    expectSeamAgainstBaseline("mcp/lody-mcp-http-server.ts", [
      [223, "    options.logger.info('[mcp-http] disabled via LODY_MCP_HTTP_DISABLED; using stdio MCP only');"],
    ], "cli");
    const cliSource = (path: string): string =>
      readFileSync(join(repoRoot, "vendor/lody/apps/cli/src", path), "utf8");
    const agentClient = cliSource("agent/agent-client.ts");
    const promptHelpers = cliSource("session/session-execution-helpers.ts");
    const mcpHttpServer = cliSource("mcp/lody-mcp-http-server.ts");
    const sandbox = cliSource("session/session-sandbox.ts");
    const sessionManager = cliSource("session/session-manager.ts");
    const service = readFileSync(
      join(repoRoot, "packages/box/rootfs/etc/s6-overlay/s6-rc.d/lody-daemon/run"),
      "utf8",
    );

    expect(agentClient).toContain("process.env.LODY_MCP_BUILTIN_DISABLED === '1'");
    expect(promptHelpers).toContain("process.env.LODY_MCP_BUILTIN_DISABLED === '1'");
    expect(mcpHttpServer).toContain(
      "[mcp] built-in server disabled via LODY_MCP_BUILTIN_DISABLED",
    );
    expect(agentClient).toContain("? 'without an MCP server'");
    expect(mcpHttpServer).toContain("? '[mcp-http] disabled via LODY_MCP_HTTP_DISABLED; built-in MCP remains disabled'");
    expect(sandbox).toContain("this.deps.environment.LODY_SESSION_CGROUP_PARENT?.trim()");
    expect(sandbox).toContain("if (options.capacityLimits === false)");
    expect(sessionManager).toContain(
      "{ capacityLimits: process.env.LODY_SESSION_CAPACITY_LIMITS !== '0' }",
    );
    expect(service).toContain("LODY_MCP_BUILTIN_DISABLED=1");
    expect(service).toContain("LODY_SESSION_CGROUP_PARENT=/blitz-user.slice/lody-sessions");
    expect(service).toContain("LODY_SESSION_CAPACITY_LIMITS=0");
  });

  it("removes nothing from session-tab-bar.tsx but the declared anchors", () => {
    expectSeam("session-tab-bar.tsx", [
      // hunk 1: the `react` import gains `type ReactNode`
      [1, "import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';"],
      // hunk 2: `ViewerTabItem` gains `'custom'` and `icon`
      [44, "/** A viewer tab item (file or diff) displayed in the tab bar. */"],
      [47, "  type: 'file' | 'diff';"],
      // hunk 4: `parentSession` becomes optional
      [60, "  parentSession: SessionMeta;"],
      // hunk 3: `ViewerTabContent` draws the host's glyph
      [465, "        {tab.type === 'file' && tab.filePath ? ("],
      [469, "        )}"],
      // hunk 5: `visibleTabIds` reads the parent id only when there is one
      [725, "    () => (showSessionTabs ? [parentSession.id, ...sortableIds] : sortableIds),"],
      [726, "    [parentSession.id, showSessionTabs, sortableIds]"],
      // hunk 6: the parent strip item is guarded on the same thing
      [770, "        {showSessionTabs && ("],
    ]);
  });

  it("removes nothing from session-detail.tsx but seam patches 4, 5, 6, 7, 15 and 16's anchors", () => {
    expectSeam("session-detail.tsx", [
      // Seam patch 4's hunks are additive and remove nothing, which is why they
      // are absent from this list and still covered by the subsequence check.
      // So are three of seam patch 6's four; its fourth is the last anchor here.
      // hunk 7 only adds `type ReactNode` to upstream's multiline `react`
      // import now, so the subsequence check covers it without a removed line.
      // hunk 11: the strip's variant follows the host's list
      [5675, '      variant="session"'],
      // hunk 14: an active host tab deselects the conversation surfaces
      [5758, "        const isActive = tabSession.id === activeTabSessionId;"],
      [5792, "        const isActive = draft.id === activeTabSessionId;"],
      // Upstream moved conversation selection into `?tab`, so hunk 17 now
      // adds an announcement inside the single URL writer and hunk 18's local
      // correction writers no longer exist. Both are additive at this pin.
      // Seam patch 6 hunk 24: the Side Chat launcher gains a third reason to be
      // disabled. Its other three hunks add lines and remove none, so they are
      // covered by the subsequence check rather than named here.
      [3495, "      disabled: launcherState === 'disabled' || isCreatingSideSession,"],
      // Seam patch 7 hunk 12: the page's GitHub state answers the
      // `githubIntegration` capability, so the two lines of the memo it was
      // built by are rewritten. Its other three hunks in this file add lines
      // and remove none.
      [1608, "    () => getSessionGitHubState(activeTabSession, workspaceOwnerSession),"],
      [1609, "    [activeTabSession, workspaceOwnerSession]"],
      // Seam patch 7 hunk 15: `session.focusInput` takes `useCommand`'s second
      // argument, so its closing line gains one. This is the ONE `});` in the
      // file the seam declares, which is why the anchor is a line number.
      [3876, "  });"],
      // Seam patch 15 hunk 11: the page's catch-up flag answers
      // `hideConnectionStatus`, so the one line the `useDelayedFlag` was built
      // from is rewritten. This takes the mobile header's spinner and the
      // `titleSyncing` override together. Its other four hunks in this file add
      // lines and remove none.
      [
        1180,
        "    activeSessionTabId !== null && isSyncingRoomSyncState(activeSessionDocSyncState),",
      ],
      // ── Seam patch 16, the mobile branch ─────────────────────────────────
      // Every anchor below is inside the `if (isMobile)` return, or inside a
      // component only that branch mounts. Hunks that only ADD lines — the
      // host-tab surface block, the appended `mobileViewers` entries, the
      // forwarded `hide*` props — are covered by the subsequence check.
      //
      // hunk 16: `MobileProjectInfo` answers the `githubIntegration`
      // capability instead of re-deriving the repo from the session
      [593, "  const repoFullName = (resolveProjectGitHubRepo(project) ?? session.repoFullName)?.trim() ?? '';"],
      [594, "  const isGitHub = project?.kind === 'github' || !!repoFullName;"],
      // hunk 12: the menu sheet's visibility row takes `hideCloudMenuItems`
      [4831, "    if (activeSessionSharing) {"],
      // hunk 13: Copy URL is guarded, which re-indents the push it wraps
      [4921, "    mobileMenuActions.push({"],
      [4922, "      id: 'copy-url',"],
      [4923, '      icon: <Link className="h-3.5 w-3.5" />,'],
      [4924, "      label: t('sessions.copyUrl', 'Copy URL'),"],
      [4925, "      onClick: () => {"],
      [4926, "        void handleCopyUrl();"],
      [4927, "      },"],
      [4928, "    });"],
      // hunk 14: Share with team gains the third term the desktop menu has
      [4932, "    if (activeSessionSharing && activeSessionSharing.visibility !== 'team') {"],
      // hunk 15: Change owner gains the same third term
      [5058, "            isMultiMemberWorkspace && !activeSession.isArchived"],
      // hunk 8: an active HOST tab hides the conversations and the drafts,
      // which is seam patch 5 hunk 13's desktop rule on the mobile branch
      [5077, "            const isActive = !hasActiveViewerTab && tabSession.id === activeTabSessionId;"],
      [5144, "            const isActive = !hasActiveViewerTab && draft.id === activeTabSessionId;"],
    ]);
  });

  it("removes nothing from the two mobile files but seam patch 16's anchors", () => {
    expectSeamAgainstBaseline("components/mobile/mobile-session-tab-sheet.tsx", [
      // hunk 1: `ViewerTabEntry['kind']` gains `'custom'`
      [67, "  kind: 'file' | 'diff' | 'pr' | 'browser' | 'files';"],
      // hunk 4: the row draws the host's glyph when it has one, which wraps
      // the element it replaces
      [244, "                        <Icon"],
      [245, '                          className="h-4 w-4 shrink-0 text-muted-foreground"'],
      [246, "                          strokeWidth={1.8}"],
      [247, '                          aria-hidden="true"'],
      [248, "                        />"],
    ]);

    expectSeamAgainstBaseline("components/mobile/mobile-home-screen.tsx", [
      // hunk 24: the GitHub segment becomes conditional, which re-indents the
      // object it wraps
      [1132, "    {"],
      [1133, "      key: 'github',"],
      [1134, "      label: githubLabel,"],
      [1135, "      icon: iosTheme ? ("],
      [1136, '        <Github className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden="true" />'],
      [1137, "      ) : ("],
      [1138, '        <MobileReactIcon icon={FaGithub} className="h-3.5 w-3.5" />'],
      [1139, "      ),"],
      [1140, "      ref: githubRef,"],
      [1141, "    },"],
      // hunk 24 again: the rendered sub-tab is pinned to Local without it
      [1924, "        active={selectedSubTab}"],
      [1930, "      {selectedSubTab === 'local' ? ("],
    ]);
  });

  it("holds a baseline of the commit vendor/lody/UPSTREAM.md pins", () => {
    // The baselines are only evidence while they are the pin's own bytes, and
    // nothing else in the tree would notice them going stale. `docs/LODY-MERGE.md`
    // §4 says to refresh them in the same change as the merge; this is what
    // fails when that is forgotten.
    const upstream = readFileSync(join(repoRoot, "vendor/lody/UPSTREAM.md"), "utf8");
    const pin = /\| Pinned commit \| `([0-9a-f]{40})` \|/u.exec(upstream)?.[1];
    expect(pin, "UPSTREAM.md still states a pinned commit").toBeDefined();
    const readme = readFileSync(join(baselineDir, "README.md"), "utf8");
    expect(readme, "the baselines name the commit they were taken from").toContain(pin ?? "");
  });

  it("declares the same six props on both sides of the seam", () => {
    const detail = readFileSync(join(vendorDir, "session-detail.tsx"), "utf8");
    for (const prop of [
      "surfaceTabs?: readonly SessionSurfaceTab[];",
      "activeSurfaceTabId?: string | null;",
      "onSurfaceTabSelect?: (tabId: string) => void;",
      "onSurfaceTabClose?: (tabId: string) => void;",
      "onSessionTabSelect?: (tabId: string) => void;",
      // Hunk 19, added in wave 3: the page returns above the strip when the
      // session does not exist, and the host loses every tab with it.
      "onSessionMissing?: (sessionId: string) => void;",
    ]) {
      expect(detail, `seam patch 5 declares ${prop}`).toContain(prop);
    }
    // Hunk 17, pinned as a CALL and not only as a declaration. A declared
    // prop that nothing invokes is exactly the shape of the defect it fixes:
    // the host keeps its tab selected, hunk 15 keeps drawing it, and a click on
    // a session tab does nothing a member can see.
    expect(detail, "the announcing URL writer exists").toContain(
      "const navigateToSessionTab = useCallback(",
    );
    expect(detail, "and it announces").toContain("onSessionTabSelectRef.current?.(tabId);");
  });

  /**
   * THE CHOKEPOINT IS ONLY A CHOKEPOINT WHILE NOTHING WALKS AROUND IT.
   *
   * Upstream moved conversation selection into `?tab`. What the seam relies on
   * now is that every explicit conversation activation formats that URL through
   * one writer, so the host notification cannot be bypassed by a second store.
   */
  it("routes every conversation-tab SELECTION through the announcing URL writer", () => {
    const detail = readFileSync(join(vendorDir, "session-detail.tsx"), "utf8");
    expect(detail, "the removed local selection store stays gone").not.toContain(
      "setActiveTabSessionId",
    );
    expect(
      [...detail.matchAll(/writeSessionUrlTab\(formatExplicitSessionTabSearch\(tabId\), options\)/gu)]
        .length,
      "explicit conversation selection has one URL chokepoint",
    ).toBe(1);

    for (const [call, what] of [
      ["navigateToSessionTab(draft.id, { push: true });", "the strip's + — a new draft tab"],
      ["navigateToSessionTab(childSessionId);", "a draft promoted to a real child session"],
      ["navigateToSessionTab(sessionId);", "a close falling back to the parent"],
      [
        "navigateToSessionTab(tabSessionId, { push: true });",
        "the browser panel opening a tab",
      ],
      ["navigateToSessionTab(tabId, { push: true });", "the strip's own tab click"],
    ] as const) {
      expect(detail, `${what} uses the announcing URL writer`).toContain(call);
    }
    // The next/previous cycle and the archived-tab restore reach the same
    // setter through `handleSessionTabSelect` rather than directly.
    expect(detail, "the tab cycle goes through the announcing handler").toContain(
      "void handleSessionTabSelect(nextTabId);",
    );
    expect(detail, "the archived-tab restore goes through it too").toContain(
      "handleSessionTabSelect(id as SessionId);",
    );
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
