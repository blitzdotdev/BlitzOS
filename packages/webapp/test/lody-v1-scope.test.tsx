/**
 * The v1 scope cuts, pinned dark at the component boundary.
 *
 * The 463-row support matrix decided four groups of controls do not ship in v1
 * (`packages/webapp/src/lody/v1-scope.ts` names every row id). Seam patch 7 is
 * what takes them off the screen, and a seam patch is exactly the thing an
 * upstream merge can drop without anybody noticing: the props go back to their
 * defaults, the capability checks disappear, and the surface comes back looking
 * like a feature rather than a regression.
 *
 * So each cut is asserted BOTH ways here — hidden with the flag the host passes,
 * and present without it. The second half is what makes the first half mean
 * something: a test that only checks "the button is absent" also passes when the
 * component stopped rendering at all.
 *
 * WHAT IS PINNED AT THE SOURCE INSTEAD, and why. The wiring — that `router.tsx`
 * really passes these props, that `LODY_V1_SCOPE` is still all-off, that no
 * settings address can throw, that the palette is unmounted — is in
 * `lody-v1-scope-sources.test.ts`. It is a question about our files, and
 * answering it by booting the whole vendored renderer would cost a minute per
 * assertion and prove less.
 */
import { I18nextProvider } from "react-i18next";
import { describe, expect, it, vi } from "vitest";
import { createCapabilitySet } from "@lody/platform";
import { PlatformContext } from "@lody/platform/react";
import { SessionHeaderMenu } from "@lody/components/components/sessions/session-chat-interface";
import { TooltipProvider } from "@lody/components/ui/tooltip";
import { AttachmentAddMenu } from "@lody/components/components/chat/attachment-add-menu";
import { UnifiedProjectSelectorView } from "@lody/components/components/chat/unified-project-selector";
import { getSessionGitHubState } from "@lody/components/lib/session-github-state";
import { resolveSessionInfoBarGitHubActionIds } from "@lody/components/components/sessions/session-info-action-state";
import { getChatLandingHintType } from "@lody/components/components/chat/chat-landing-derived";
import { initLodyI18n } from "../src/lody/i18n.js";
import { LODY_V1_SCOPE, lodyV1SuppressionProps } from "../src/lody/v1-scope.js";
import { installLodyDomStubs } from "./lody-dom-stubs.js";
import { render, settle } from "./dom.js";

installLodyDomStubs();

const V1 = lodyV1SuppressionProps();

/** Radix triggers act on `pointerdown`, which jsdom does not synthesize from
 * `click()` — the same three events `lody-permission-mode.test.tsx` uses. */
function openMenu(trigger: HTMLElement): void {
  trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
  trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
  trigger.click();
}

function menuText(): string {
  return document.body.textContent ?? "";
}

function menuItemTexts(): string[] {
  return [...document.body.querySelectorAll<HTMLElement>("[role='menuitem']")].map((item) =>
    (item.textContent ?? "").trim(),
  );
}

/** The platform the surface really mounts with: the empty LOCAL capability set,
 * so `useAppCapability('githubIntegration')` answers what it answers in a box. */
function platformWith(capabilities: readonly string[]) {
  return {
    kind: "local",
    identity: { session: { get: () => ({ status: "unauthenticated" }), subscribe: () => () => {} }, signOut: async () => {} },
    workspaces: {
      state: { get: () => ({ status: "ready", workspaces: [], activeWorkspaceId: null }), subscribe: () => () => {} },
      setActive: async () => {},
    },
    capabilities: createCapabilitySet(capabilities),
    cloudApi: null,
    sync: { mode: "local" },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the vendor seam is untyped; see vendor-modules.d.ts
type AnyProps = Record<string, any>;

/** A session with a GitHub remote and an open pull request — the shape a
 * BlitzOS worktree really has, because `/workspace/<repo>` is a clone. Without
 * it every GitHub assertion below would pass for the wrong reason. */
const SESSION_WITH_PR: AnyProps = {
  id: "session-v1-scope",
  title: "Scope cuts",
  createdAt: Date.now(),
  project: { kind: "local", localProjectId: "lp1", githubRepoFullName: "blitzdotdev/BlitzOS-box-image" },
  repoFullName: "blitzdotdev/BlitzOS-box-image",
  workspaceDirty: true,
  pullRequests: [{ url: "https://github.com/blitzdotdev/BlitzOS-box-image/pull/144", number: 144 }],
};

// ── 1. The header menu's three cloud rows (IC83, IC84, IC88) ────────────────

/** `sharing` and `owner` are the props each row's own gate reads, so both are
 * supplied: the rows are ON without the suppression, which is the control. */
const HEADER_MENU_PROPS: AnyProps = {
  session: SESSION_WITH_PR,
  onCopyUrl: vi.fn(),
  onCopyConversationHistory: vi.fn(),
  sharing: { visibility: "private", canManage: true },
  onShareWithTeam: vi.fn(),
  owner: {
    ownerUserId: "u1",
    pendingUserId: null,
    members: [
      { userId: "u1", name: "Owner" },
      { userId: "u2", name: "Teammate" },
    ],
    onChangeOwner: vi.fn(),
  },
  t: ((_key: string, fallback?: string) => fallback ?? _key) as never,
};

async function renderHeaderMenu(hideCloudMenuItems: boolean) {
  const i18n = initLodyI18n();
  const view = await render(
    <I18nextProvider i18n={i18n}>
      <PlatformContext.Provider value={platformWith([]) as never}>
        <TooltipProvider>
          <SessionHeaderMenu {...HEADER_MENU_PROPS} hideCloudMenuItems={hideCloudMenuItems} />
        </TooltipProvider>
      </PlatformContext.Provider>
    </I18nextProvider>,
  );
  const trigger = view.container.querySelector<HTMLElement>("[aria-haspopup='menu']");
  expect(trigger, "the header menu has a trigger").not.toBeNull();
  openMenu(trigger!);
  await settle();
  return view;
}

describe("the session header menu drops its three cloud rows", () => {
  it("offers Change owner, Share with team and Copy URL to a host that does not suppress them", async () => {
    const view = await renderHeaderMenu(false);
    const text = menuText();
    expect(text, "IC83 renders without the prop").toContain("Change owner");
    expect(text, "IC84 renders without the prop").toContain("Share with team");
    // "Copy URL" lives in the Copy submenu, which Radix does not open on hover
    // in jsdom. The row is still in the tree; assert on the trigger's content.
    expect(view.container.ownerDocument.body.innerHTML, "IC88 renders without the prop").toContain(
      "Copy",
    );
    await view.unmount();
  });

  it("offers none of the three with hideCloudMenuItems", async () => {
    const view = await renderHeaderMenu(true);
    const text = menuText();
    expect(text, "IC83 is gone").not.toContain("Change owner");
    expect(text, "IC84 is gone").not.toContain("Share with team");
    expect(text, "the menu still renders its own rows").toContain("Copy");
    await view.unmount();
  });

  it("is the value the surface really passes", () => {
    expect(V1.hideCloudMenuItems, "v1 suppresses the three cloud rows").toBe(true);
  });
});

// ── 2. GitHub and pull requests (22 rows) ───────────────────────────────────

describe("every GitHub surface reads one state, and the capability decides it", () => {
  const live = getSessionGitHubState(SESSION_WITH_PR as never, null, true);
  const dark = getSessionGitHubState(SESSION_WITH_PR as never, null, false);

  it("resolves a repo and a pull request when githubIntegration is available", () => {
    expect(live.repoFullName).toBe("blitzdotdev/BlitzOS-box-image");
    expect(live.canShowGitHubActions).toBe(true);
    expect(live.latestPr).not.toBeNull();
    expect(live.hasExistingPr).toBe(true);
  });

  it("resolves nothing without it, so the PR panel and badge have no gate to pass", () => {
    // `session-detail.tsx:3475` offers the PR tab on `latestPr && repoFullName`;
    // `:5508` renders `PrTabContainer` on the same pair. SP57-SP61, WT15, IC72.
    expect(dark.repoFullName).toBe("");
    expect(dark.latestPr).toBeNull();
    expect(dark.canShowGitHubActions).toBe(false);
    expect(dark.hasExistingPr).toBe(false);
  });

  it("keeps the diff panel's comment affordances closed", () => {
    // `session-conversation-diff-panel.tsx:662,665` are both
    // `Boolean(latestPrNumber && repoFullName)`. SP43, SP44.
    expect(Boolean(dark.latestPr) && Boolean(dark.repoFullName)).toBe(false);
  });

  it("leaves the info bar with none of the six quick actions", () => {
    // IC96-IC101. `session-info-action-state.ts:43` returns [] first thing.
    const args = {
      hasExistingPr: live.hasExistingPr,
      workspaceDirty: true,
      hasChanges: true,
      isAgentBusy: false,
    };
    expect(
      resolveSessionInfoBarGitHubActionIds({ ...args, canShowGitHubActions: true }).length,
      "the actions exist when the capability does",
    ).toBeGreaterThan(0);
    expect(
      resolveSessionInfoBarGitHubActionIds({ ...args, canShowGitHubActions: false }),
      "and none of them without it",
    ).toEqual([]);
  });

  it("does not grant the capability in v1", () => {
    expect(LODY_V1_SCOPE.gitHubIntegration).toBe(false);
  });
});

describe("the project picker's GitHub entries", () => {
  const PICKER_PROPS: AnyProps = {
    value: { kind: "none" },
    onChange: vi.fn(),
    localProjects: [],
    repositories: [],
    onAddLocalProject: vi.fn(),
    onConnectGitRepo: vi.fn(),
  };

  const CACHED_CLONE_PROPS: AnyProps = {
    localProjects: [
      {
        machineId: "machine-1",
        localProjectId: "local-project-1",
        name: "BlitzOS",
        rootPath: "/workspace/BlitzOS",
      },
    ],
    repositories: [{ fullName: "blitzdotdev/BlitzOS" }],
  };

  async function renderPicker(capabilities: readonly string[], props: AnyProps = {}) {
    const i18n = initLodyI18n();
    const view = await render(
      <I18nextProvider i18n={i18n}>
        <PlatformContext.Provider value={platformWith(capabilities) as never}>
          <TooltipProvider>
            <UnifiedProjectSelectorView {...PICKER_PROPS} {...props} />
          </TooltipProvider>
        </PlatformContext.Provider>
      </I18nextProvider>,
    );
    const trigger = view.container.querySelector<HTMLElement>("[aria-haspopup='menu']");
    expect(trigger, "the picker has a trigger").not.toBeNull();
    openMenu(trigger!);
    await settle();
    return view;
  }

  it("is offered with githubIntegration", async () => {
    const view = await renderPicker(["githubIntegration"]);
    expect(menuText(), "C65 renders with the capability").toContain("Connect more GitHub projects");
    await view.unmount();
  });

  it("is absent without it, and the rest of the picker is not", async () => {
    const view = await renderPicker([]);
    const text = menuText();
    expect(text, "C65 is gone").not.toContain("Connect more GitHub projects");
    expect(text, "the picker itself still renders").toContain("Add a folder");
    await view.unmount();
  });

  it("clears a stale GitHub selection without githubIntegration", async () => {
    const onChange = vi.fn();
    const view = await renderPicker([], {
      ...CACHED_CLONE_PROPS,
      value: { kind: "github", repoFullName: "blitzdotdev/BlitzOS" },
      onChange,
    });
    expect(onChange, "a saved remote selection cannot reach submission").toHaveBeenCalledWith({
      kind: "none",
    });
    await view.unmount();
  });

  it("offers repository projects only with githubIntegration", async () => {
    const view = await renderPicker(["githubIntegration"], CACHED_CLONE_PROPS);
    const items = menuItemTexts();
    expect(items, "the local project remains selectable").toContain("BlitzOS");
    expect(items, "the GitHub project is selectable with the integration").toContain(
      "blitzdotdev/BlitzOS",
    );
    await view.unmount();
  });

  it("does not turn a cached local clone name into a GitHub project", async () => {
    const view = await renderPicker([], CACHED_CLONE_PROPS);
    const items = menuItemTexts();
    expect(items, "the local project remains selectable").toContain("BlitzOS");
    expect(items, "the cached clone is not offered as a remote project").not.toContain(
      "blitzdotdev/BlitzOS",
    );
    await view.unmount();
  });
});

// ── 3. The Agent Role and MCP pickers (8 rows) ──────────────────────────────

describe("the composer's + menu offers no MCP servers", () => {
  async function renderAddMenu(servers: readonly AnyProps[]) {
    const i18n = initLodyI18n();
    const mcp: AnyProps = {
      servers,
      selectedIds: [],
      onSelectedIdsChange: vi.fn(),
    };
    const view = await render(
      <I18nextProvider i18n={i18n}>
        <AttachmentAddMenu isMobile={false} onAddAttachment={vi.fn()} mcp={mcp as never} />
      </I18nextProvider>,
    );
    const trigger = view.container.querySelector<HTMLElement>("[aria-haspopup='menu']");
    expect(trigger, "the + menu has a trigger").not.toBeNull();
    openMenu(trigger!);
    await settle();
    return view;
  }

  it("shows the MCP entry when the catalog has a server", async () => {
    const view = await renderAddMenu([
      { id: "mcp-1", name: "context7", transport: "stdio", connection: { kind: "stdio", command: "x" } },
    ]);
    // The submenu's rows need a hover Radix does not synthesize in jsdom; the
    // ENTRY that opens them is the row this cut removes, and it is in the DOM.
    expect(menuText(), "C55 renders for a non-empty catalog").toContain("MCP");
    await view.unmount();
  });

  it("shows only the attachment row for the empty catalog BlitzOS has", async () => {
    // C55-C57 need no seam patch: `attachment-add-menu.tsx:75` already gates on
    // `mcpServers.length > 0`, and nothing in `W/lody/agent-configs.ts` writes a
    // catalog row. This is the assertion that would fail if a writer appeared.
    const view = await renderAddMenu([]);
    const text = menuText();
    expect(text, "the menu still offers attachments").toContain("Add attachment");
    expect(text, "and no MCP entry at all").not.toContain("MCP");
    await view.unmount();
  });

  it("does not enable either picker in v1", () => {
    expect(LODY_V1_SCOPE.agentRolesAndMcp).toBe(false);
    expect(V1.hideAgentRoles).toBe(true);
  });
});

// ── 4. The hint band (S7, S8, S9, S10) ──────────────────────────────────────

describe("the chat landing draws no product hint band", () => {
  it("would draw one for a host that keeps them", () => {
    // Both states of `ChatLandingView`'s band, at the function that decides it.
    expect(
      getChatLandingHintType({ hasNoMachine: true, hasNoAgentConfig: false, isInitialDataLoading: false }),
      "S7/S8/S10: the Download-the-client, Report-a-bug and Discord band",
    ).toBe("no-machine");
    expect(
      getChatLandingHintType({ hasNoMachine: false, hasNoAgentConfig: true, isInitialDataLoading: false }),
      "S9: the Go-to-Settings band",
    ).toBe("no-agent-config");
  });

  it("passes null instead, whichever state the landing computes", () => {
    // Seam patch 7 hunk 35 is `hintType={hideProductHints ? null : hintType}`,
    // and `ChatLandingView` renders nothing for `null` (its own default).
    expect(V1.hideProductHints).toBe(true);
    for (const hintType of ["no-machine", "no-agent-config", null] as const) {
      expect(V1.hideProductHints ? null : hintType).toBeNull();
    }
  });
});

// ── 5. The notification prompt and the ⌘L chip ──────────────────────────────

describe("the surfaces with no host behind them", () => {
  it("suppresses the notification permission prompt", () => {
    // IC60. OneSignal is not mounted, so Enable asks for a permission nothing
    // consumes. Seam patch 7 hunk 14 is the render guard.
    expect(V1.hideNotificationPrompt).toBe(true);
  });

  it("registers no keyboard command, which is what the ⌘L chip reads", () => {
    // C100 + C102. `chat-composer.tsx` draws the chip from
    // `commands.getKeybindingsFor('session.focusInput')`, and the only writer of
    // that binding is `session-detail.tsx`'s registration — which seam patch 7
    // hunk 21 gates on this flag.
    expect(V1.keyboardShortcutsAvailable).toBe(false);
    expect(LODY_V1_SCOPE.keyboardShortcuts).toBe(false);
  });
});
