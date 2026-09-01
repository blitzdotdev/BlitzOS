/**
 * What the Lody surface offers in BlitzOS v1, in one place.
 *
 * The 463-row support matrix put 55 rows in four KILL areas and 53 more in five
 * DECIDE areas. The approved v1 answer keeps most of the product and takes four
 * groups off the screen. Two of those groups are DELETED — the code paths that
 * reach them are gone — and two are HIDDEN, because the decision is "not in v1"
 * rather than "never":
 *
 * | Flag | Rows | Why it is off |
 * |---|---|---|
 * | `gitHubIntegration` | R16, C17-C19, C65, C72, IC67, IC72, IC96-IC101, SP43, SP44, SP57-SP61, WT15 | BlitzOS connects no GitHub App, so every PR flow fails past the button. |
 * | `agentRolesAndMcp` | C55-C57, C86-C89, C91 | Nothing writes the workspace Agent Role or MCP catalog rows, so both pickers are empty by construction. |
 * | `keyboardShortcuts` | X1-X5, C24, C100, C102, C103, T27 | We mount neither `commands.attach(window)` nor `CommandPalette`, so no chord is answered. |
 * | `cloudSurfaces` | S7-S10, IC60, IC83, IC84, IC88, T25 | Each one advertises Lody's cloud, Lody's Discord, Lody's desktop app, a settings screen we do not serve, or a team scope a one-member workspace cannot switch. |
 * | `languageService` | SP26 | A box runs no language service, so Go to Definition and Find References answer "Host language service does not support this file" for every identifier in every file. |
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
 * 2. The other three are props on the two components we mount, declared by seam
 *    patch 7 and passed from `router.tsx`. Upstream has no gate for them.
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
 * `ChatLanding`, `SessionDetail` and `ArchiveView` (seam patches 7, 10 and 14).
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
}

export const lodyV1SuppressionProps = (): LodyV1SuppressionProps => ({
  hideCloudMenuItems: !LODY_V1_SCOPE.cloudSurfaces,
  hideNotificationPrompt: !LODY_V1_SCOPE.cloudSurfaces,
  hideProductHints: !LODY_V1_SCOPE.cloudSurfaces,
  hideAgentRoles: !LODY_V1_SCOPE.agentRolesAndMcp,
  keyboardShortcutsAvailable: LODY_V1_SCOPE.keyboardShortcuts,
  hideLanguageServiceActions: !LODY_V1_SCOPE.languageService,
  hideTeamScope: !LODY_V1_SCOPE.cloudSurfaces,
});
