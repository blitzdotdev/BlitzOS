/**
 * What the Lody surface offers in BlitzOS v1, in one place.
 *
 * The 463-row support matrix put 55 rows in four KILL areas and 53 more in five
 * DECIDE areas. The approved v1 answer keeps most of the product and takes four
 * groups off the screen. Two of those groups are DELETED — the code paths that
 * reach them are gone — and two are HIDDEN, because the decision is "not in v1"
 * rather than "never". The table has grown past those four; each row still
 * names one group and why it is off:
 *
 * | Flag | Rows | Why it is off |
 * |---|---|---|
 * | `gitHubIntegration` | R16, C17-C19, C65, C72, IC67, IC72, IC96-IC101, SP43, SP44, SP57-SP61, WT15 | BlitzOS connects no GitHub App, so every PR flow fails past the button. |
 * | `agentRolesAndMcp` | C55-C57, C86-C89, C91 | Nothing writes the workspace Agent Role or MCP catalog rows, so both pickers are empty by construction. |
 * | `keyboardShortcuts` | X1-X5, C24, C100, C102, C103, T27 | We mount neither `commands.attach(window)` nor `CommandPalette`, so no chord is answered. |
 * | `cloudSurfaces` | S7-S10, IC60, IC83, IC84, IC88, T25 | Each one advertises Lody's cloud, Lody's Discord, Lody's desktop app, a settings screen we do not serve, or a team scope a one-member workspace cannot switch. |
 * | `languageService` | SP26 | A box runs no language service, so Go to Definition and Find References answer "Host language service does not support this file" for every identifier in every file. |
 * | `connectionStatus` | IC64, IC65 | BlitzOS reports connectivity itself, in the footer. Lody's own status chip, catch-up spinners and mobile banner describe the same outage in different words. |
 * | `machineSelection` | the composer's machine chip | A BlitzOS workspace is one member, one machine, one box. The picker moves a session between the machines an account has paired, and here every option it can list is the machine already selected. Seam patch 24. |
 * | `cloudImageUpload` | image attachments | A box has no Lody cloud account. Cloud image upload cannot succeed, and its degrade path already sends each image as a file attachment. Seam patch 27. |
 *
 * Three flags define host boundaries instead of future scope:
 * `connectionStatus`, `machineSelection`, and `cloudImageUpload`.
 * The remaining flags name surfaces BlitzOS does not serve yet.
 *
 * `connectionStatus` names a surface BlitzOS serves ITSELF:
 * `shell/workspace-status-line.ts`
 * builds one sentence for the whole workspace — `workspace running · box
 * unreachable` when the machine runs and the browser cannot reach its gateway —
 * out of the probe in `box-gateway-health.ts`, and the same gateway carries the
 * terminal, the files, the previews and this surface. Two reports of one outage
 * tell a member which to believe and nothing else. So the flag is an OWNERSHIP
 * boundary: flipping it on is what a host that stopped reporting connectivity
 * would do, not what BlitzOS does when it grows a feature. Seam patch 15.
 *
 * MOBILE IS IN, AND IT MOVED THREE OF THESE (2026-09-02). Both real routes used
 * to drop Lody's mobile branch, so area 23 was KILL and no flag had to reach a
 * phone. The branch is mounted now (`MobileSessionStack.tsx`), and seam patch 16
 * is what makes the flags above answer there as well as on a desktop. Three of
 * them reached NOTHING on that branch: `cloudSurfaces`, `agentRolesAndMcp` and
 * `connectionStatus` all travel through `getSharedChatSurfaceProps`, which
 * `session-detail.tsx` defines 952 lines BELOW its own `if (isMobile)` return.
 * `plans/LODY-V1-SCOPE.md` §5 records the amendment.
 *
 * HOW A FLAG REACHES THE VENDORED RENDERER. Two ways, and which one applies is
 * a property of the flag, not a preference:
 *
 * 1. `gitHubIntegration` reuses UPSTREAM'S OWN GATE. `PLATFORM_CAPABILITIES`
 *    already names `githubIntegration` ("GitHub App integration (repo registry,
 *    brokered tokens, PR status)"), and the local platform declares an empty
 *    capability set, so the answer is already `false` here. Seam patch 7 only
 *    makes the surfaces that forgot to ask, ask. The flag below decides what
 *    `createBlitzPlatformProvider` grants, so flipping it is one line — see
 *    `lodyExtraCapabilities` for what a flip does NOT do.
 * 2. The others are props on the components we mount, declared by seam patches
 *    7, 15, 16, 24 and 27, and passed from `router.tsx` and
 *    `MobileSessionStack.tsx`. Upstream has no gate for them.
 *
 * The tests that keep these areas dark are
 * `packages/webapp/test/lody-v1-scope.test.tsx` (the DOM) and
 * `packages/webapp/test/lody-v1-scope-sources.test.ts` (the wiring).
 */
/** One name out of `vendor/lody/packages/platform/src/capabilities.ts`. Stated
 * here rather than imported: `vendor-modules.d.ts` declares `@lody/platform`
 * untyped, so an import would be `any` and would not check the string. */
type LodyPlatformCapability = "githubIntegration";

export interface LodyV1Scope {
  /** GitHub and pull-request flows (22 rows). HIDDEN, not deleted. */
  readonly gitHubIntegration: boolean;
  /** The Agent Role picker and the MCP server picker (8 rows). HIDDEN. */
  readonly agentRolesAndMcp: boolean;
  /** The command palette, the global dispatcher and the ⌘L hint chip (9 rows). HIDDEN. */
  readonly keyboardShortcuts: boolean;
  /**
   * Lody-cloud and wrong-product surfaces (10 rows). DELETED for v1: the header
   * menu's "Change owner", "Share with team" and "Copy URL", the notification
   * permission prompt, the no-machine / no-agent hint band with its
   * Download-the-client, Report-a-bug, Discord and Go-to-settings buttons, and
   * the archive page's My Tasks / All Tasks scope control.
   */
  readonly cloudSurfaces: boolean;
  /**
   * The editor's two LSP entry points (1 row). HIDDEN, not deleted: a box that
   * grows a language service flips this and the actions come back.
   */
  readonly languageService: boolean;
  /**
   * Every Lody surface that narrates the connection (2 rows). DELETED for v1,
   * and the reason is ownership rather than scope: the BlitzOS footer says it.
   *
   * What goes dark: the composer status chip's browser-offline ("You are
   * offline. Reconnect to sync.") and machine-offline states, the ambient
   * catch-up spinner in the session info bar and the mobile session header, the
   * page header's offline-cloud glyph, the file viewer's offline glyph, and the
   * mobile home's connection banner.
   *
   * What stays, deliberately: the same chip's `machine-removed` state, which is
   * a membership fact and the only one of the three that blocks sending; and
   * every message a panel draws INSTEAD of its data ("Connecting to code
   * session…", "Syncing changes…"), which the footer cannot replace.
   */
  readonly connectionStatus: boolean;
  /**
   * The composer's machine picker, on the desktop landing and in the mobile
   * new-chat sheet. DELETED for v1, and like `connectionStatus` the reason is
   * ownership rather than scope: a surface here is served by ONE box, which
   * is the one machine its daemon reports, so the chip's list has exactly one
   * entry and picking it changes nothing.
   *
   * What stays: the selection itself. `selectedMachineId` is synced from the
   * chosen agent config and local project (`chat-landing.tsx`), not from the
   * chip, so a session still runs where it always ran — nothing about the
   * send path reads this flag.
   *
   * Flipping it on is what a host that pairs a member with several machines
   * would do. That is the member-machines direction, not a v1 gap.
   */
  readonly machineSelection: boolean;
  /**
   * Lody cloud image upload. HIDDEN because the box lacks this capability.
   *
   * A box has no Lody cloud account, so `uploadSessionImage` can never succeed.
   * The degrade path already sends every image through the file attachment transport.
   */
  readonly cloudImageUpload: boolean;
}

/**
 * v1. Every flag is off, and each is one line to revisit.
 *
 * `as const satisfies` rather than a plain annotation: the literal types survive,
 * so a test can state `LODY_V1_SCOPE.gitHubIntegration === false` and a flip
 * fails that test rather than passing quietly.
 */
export const LODY_V1_SCOPE = {
  gitHubIntegration: false,
  agentRolesAndMcp: false,
  keyboardShortcuts: false,
  cloudSurfaces: false,
  languageService: false,
  connectionStatus: false,
  machineSelection: false,
  cloudImageUpload: false,
} as const satisfies LodyV1Scope;

/**
 * The platform capabilities BlitzOS grants on top of the empty local set.
 *
 * WHAT A FLIP DOES NOT DO. Upstream's contract says a capability claimed while
 * `cloudApi` is null is an invalid assembly
 * (`vendor/lody/packages/platform/src/provider.ts:98`), and ours is null — the
 * same reason `plans/LODY-SESSIONS.md` §7.2's request for `remoteMachines` was
 * refused in `platform.tsx`. So granting `githubIntegration` re-renders the PR
 * surfaces but does not make them work: that needs a repo registry and brokered
 * tokens BlitzOS does not have yet. The flag is where that work starts, not
 * where it ends.
 */
export const lodyExtraCapabilities = (): readonly LodyPlatformCapability[] =>
  LODY_V1_SCOPE.gitHubIntegration ? (["githubIntegration"] as const) : [];

/**
 * The suppression props `router.tsx` passes to the three components it mounts:
 * `ChatLanding`, `SessionDetail` and `ArchiveView` (seam patches 7, 10, 14, 15).
 * Built here so the mounts cannot disagree, and so a test reads the same object
 * the surface does.
 */
export interface LodyV1SuppressionProps {
  readonly hideCloudMenuItems: boolean;
  readonly hideNotificationPrompt: boolean;
  readonly hideProductHints: boolean;
  readonly hideAgentRoles: boolean;
  readonly keyboardShortcutsAvailable: boolean;
  readonly hideLanguageServiceActions: boolean;
  /**
   * The archive page's My Tasks / All Tasks control (T25, seam patch 14).
   *
   * NOT the PR badge on the same page: that answers upstream's own
   * `githubIntegration` capability, which the local platform already declines,
   * so there is no prop for it and nothing here to flip.
   */
  readonly hideTeamScope: boolean;
  /**
  /**
   * The settings gear in the mobile home header (seam patch 16).
   *
   * The same species as S9, the hint band's Go-to-settings button, so it reads
   * the same flag: BlitzOS serves settings from its own chrome, and every Lody
   * settings address in our tree is a stub that renders nothing
   * (`router.tsx`, `SETTINGS_STUB_PATHS`). The desktop landing draws no gear, so
   * this prop has no desktop twin.
   */
  readonly hideSettingsEntry: boolean;
  /**
   * Every connection and sync surface Lody draws (IC64, IC65, seam patch 15).
   * Passed to `SessionDetail` and to `ChatLanding`; the session page rides it on
   * to every chat surface and every file viewer it mounts.
   *
   * NOT the rail's `ConnectionPill`: it renders inside `LoroSidebar`'s workspace
   * header, which `SessionRailSidebar.tsx` already suppresses with seam patch
   * 2's `hideHeader`, and our rail passes the pill no state either way.
   */
  readonly hideConnectionStatus: boolean;
  /**
   * The composer's machine picker (seam patch 24). Passed to `ChatLanding`
   * alone: the session composer has no machine chip, because a session is
   * already bound to the machine it was started on.
   */
  readonly hideMachineSelector: boolean;
  /**
   * The cloud image upload path (seam patch 27).
   *
   * A box has no Lody cloud account, so `uploadSessionImage` can never succeed.
   * Every image already becomes a file attachment through the degrade path.
   */
  readonly disableImageUpload: boolean;
}

export const lodyV1SuppressionProps = (): LodyV1SuppressionProps => ({
  hideCloudMenuItems: !LODY_V1_SCOPE.cloudSurfaces,
  hideNotificationPrompt: !LODY_V1_SCOPE.cloudSurfaces,
  hideProductHints: !LODY_V1_SCOPE.cloudSurfaces,
  hideAgentRoles: !LODY_V1_SCOPE.agentRolesAndMcp,
  keyboardShortcutsAvailable: LODY_V1_SCOPE.keyboardShortcuts,
  hideLanguageServiceActions: !LODY_V1_SCOPE.languageService,
  hideTeamScope: !LODY_V1_SCOPE.cloudSurfaces,
  hideSettingsEntry: !LODY_V1_SCOPE.cloudSurfaces,
  hideConnectionStatus: !LODY_V1_SCOPE.connectionStatus,
  hideMachineSelector: !LODY_V1_SCOPE.machineSelection,
  disableImageUpload: !LODY_V1_SCOPE.cloudImageUpload,
});
