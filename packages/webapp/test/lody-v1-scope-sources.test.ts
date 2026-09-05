/**
 * The v1 scope cuts, pinned at the wiring rather than at the pixel.
 *
 * `lody-v1-scope.test.tsx` mounts the components and proves each suppression
 * WORKS. This file proves it is CONNECTED: that the one constant is still all
 * off, that `router.tsx` really hands every prop to the two components we mount,
 * that no settings address can throw, that our tree mounts no command palette
 * and no mobile branch, and that seam patch 7 is declared where an upstream-merge
 * agent reads it (`vendor/lody/BLITZ-PATCHES.md`).
 *
 * A SOURCE TEST, DELIBERATELY, and for the reason `lody-router-targets.test.ts`
 * gives: importing `router.tsx` pulls the whole vendored renderer — Monaco,
 * three.js, the Loro WASM — for questions answered by comparing strings.
 *
 * The one thing this file must not become is two copies of the same list
 * agreeing with each other. Every list below is READ from the tree it describes:
 * the settings addresses come from upstream's own route directory, the props
 * come from `v1-scope.ts`'s exported shape, and the seam patch's file list comes
 * out of `BLITZ-PATCHES.md`.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LODY_V1_SCOPE,
  lodyExtraCapabilities,
  lodyV1SuppressionProps,
} from "../src/lody/v1-scope.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const lodySrc = join(repoRoot, "packages/webapp/src/lody");
const vendorSrc = join(repoRoot, "vendor/lody/packages/components/src");

const read = (path: string): string => readFileSync(path, "utf8");
const ourSource = (file: string): string => read(join(lodySrc, file));

describe("the v1 scope constant", () => {
  it("still cuts every group", () => {
    // A flip is a product decision, not a refactor. It fails here first.
    // `connectionStatus` is seam patch 15's, and it is an ownership boundary
    // rather than a "not in v1" cut — see `v1-scope.ts`. Mounting the mobile
    // branch is what gave it a phone to answer on.
    expect(LODY_V1_SCOPE).toEqual({
      gitHubIntegration: false,
      agentRolesAndMcp: false,
      keyboardShortcuts: false,
      cloudSurfaces: false,
      languageService: false,
      connectionStatus: false,
      // Seam patch 24's. Like `connectionStatus` an ownership boundary: one
      // workspace, one member's machine, one box, so the picker offers the
      // machine it already shows.
      machineSelection: false,
    });
  });

  it("grants no extra platform capability, so the local empty set is what mounts", () => {
    expect(lodyExtraCapabilities()).toEqual([]);
  });

  it("turns every flag into the suppression the vendored props expect", () => {
    expect(lodyV1SuppressionProps()).toEqual({
      hideCloudMenuItems: true,
      hideNotificationPrompt: true,
      hideProductHints: true,
      hideAgentRoles: true,
      keyboardShortcutsAvailable: false,
      hideLanguageServiceActions: true,
      hideTeamScope: true,
      // Seam patch 16's one. `hideSettingsEntry` reads `cloudSurfaces`, the
      // flag that already covers the hint band's Go-to-settings button.
      hideSettingsEntry: true,
      hideConnectionStatus: true,
      hideMachineSelector: true,
    });
  });
});

describe("the two mounts hand the suppression to all four mounted components", () => {
  const router = ourSource("router.tsx");
  const stack = ourSource("MobileSessionStack.tsx");

  it("passes every prop `lodyV1SuppressionProps` returns", () => {
    // Read from the returned object rather than restated, so adding a
    // suppression and forgetting to pass it fails here.
    //
    // TWO MOUNTS, ONE OBJECT. `router.tsx` mounts the desktop pages and the
    // archive; `MobileSessionStack.tsx` mounts the phone's. A prop may live in
    // either — `hideSettingsEntry` has no desktop surface at all — but it must
    // live in ONE of them, or the flag reaches nothing.
    for (const prop of Object.keys(lodyV1SuppressionProps())) {
      const passed = `${prop}={V1.${prop}}`;
      expect(
        router.includes(passed) || stack.includes(passed),
        `${prop} is passed by router.tsx or MobileSessionStack.tsx`,
      ).toBe(true);
    }
  });

  it("builds them from the scope constant and nothing else", () => {
    for (const [name, source] of [["router.tsx", router], ["MobileSessionStack.tsx", stack]] as const) {
      expect(source, `${name} reads the scope constant`).toContain('from "./v1-scope.js"');
      expect(source, `${name} builds the props once`).toContain(
        "const V1 = lodyV1SuppressionProps();",
      );
    }
  });

  it("gives ChatLanding the hint, Role and connection suppressions", () => {
    const start = router.indexOf("<ChatLanding");
    const landing = router.slice(start, router.indexOf("<SessionDetail"));
    expect(landing).toContain("hideProductHints={V1.hideProductHints}");
    expect(landing).toContain("hideAgentRoles={V1.hideAgentRoles}");
    expect(landing).toContain("hideConnectionStatus={V1.hideConnectionStatus}");
    expect(landing).toContain("hideMachineSelector={V1.hideMachineSelector}");
  });

  it("gives ArchiveView the team-scope suppression, and no prop for the PR badge", () => {
    const start = router.indexOf("<ArchiveView");
    expect(start, "router.tsx mounts ArchiveView").toBeGreaterThan(-1);
    const archive = router.slice(start, router.indexOf("</AppThemeShell>", start));
    expect(archive).toContain("hideTeamScope={V1.hideTeamScope}");
    // The badge is upstream's own capability gate, so there is deliberately no
    // second prop here. A prop appearing would mean the gate was re-invented.
    expect(archive).not.toContain("hidePullRequest");
  });

  it("gives SessionDetail the menu, prompt, Role and keyboard suppressions", () => {
    const detail = router.slice(router.indexOf("<SessionDetail"), router.length);
    for (const prop of [
      "hideCloudMenuItems",
      "hideNotificationPrompt",
      "hideAgentRoles",
      "keyboardShortcutsAvailable",
      // Seam patch 10's one suppression, wired the same way.
      "hideLanguageServiceActions",
      // Seam patch 15's, likewise.
      "hideConnectionStatus",
    ]) {
      expect(detail, `SessionDetail receives ${prop}`).toContain(`${prop}={V1.${prop}}`);
    }
  });
});

describe("the settings surface: X8, the latent throw, settled", () => {
  /** Upstream's own settings pages, from its route directory. */
  function upstreamSettingsPages(): string[] {
    const directory = join(vendorSrc, "routes/$workspaceName/_auth/settings");
    return readdirSync(directory)
      .filter((entry) => entry.endsWith(".tsx"))
      .map((entry) => entry.slice(0, -".tsx".length))
      .sort();
  }

  /** `SETTINGS_STUB_PATHS`, read out of `router.tsx`. */
  function stubbedSettingsPages(): string[] {
    const source = ourSource("router.tsx");
    const block = /const SETTINGS_STUB_PATHS = \[([^\]]*)\]/u.exec(source)?.[1];
    expect(block, "SETTINGS_STUB_PATHS is still a literal array").toBeDefined();
    return [...(block ?? "").matchAll(/"([^"]+)"/gu)].map((match) => match[1] as string).sort();
  }

  it("stubs every settings page upstream declares, not only the thirteen it navigates to", () => {
    // `router.navigate({ to })` THROWS on an address the tree does not hold.
    // The old list held the thirteen `use-open-settings.ts` reaches on mobile;
    // upstream declares twenty pages, so seven addresses were one `<Link>` away
    // from crashing the surface.
    const upstream = upstreamSettingsPages();
    expect(upstream.length, "upstream still declares twenty settings pages").toBe(20);
    expect(stubbedSettingsPages()).toEqual(upstream);
  });

  it("renders every one of them as nothing", () => {
    // The decision is DELETE the affordances, not ship a settings surface. What
    // is left is an address that resolves.
    const source = ourSource("router.tsx");
    expect(source).toContain(
      "createRoute({ getParentRoute: () => settingsRoute, path, component: EmptyRoute })",
    );
    expect(source).toContain("function EmptyRoute() {\n  return null;\n}");
  });

  it("reaches no 'open settings' affordance from our own code", () => {
    // Every one that a BlitzOS mount could reach is gone with its own surface:
    // S9 with the hint band, C65 with the GitHub cut, IC60 with the notification
    // prompt. Nothing in our tree opens settings itself.
    for (const file of readdirSync(lodySrc).filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))) {
      const source = ourSource(file);
      expect(source, `${file} does not open Lody's settings`).not.toContain("useOpenSettings");
      expect(source, `${file} does not open Lody's settings`).not.toContain("openSettings(");
    }
  });
});

describe("the command palette and the keyboard dispatcher stay unmounted", () => {
  it("registers no built-in command, which is where every binding comes from", () => {
    // `lody-terminal-tab-wave3.test.tsx` pins `commands.attach` and
    // `<CommandPalette />` from both sides. This adds the third writer: without
    // `registerBuiltInCommands()` the registry holds only what a mounted page
    // registers, and seam patch 7 hunk 21 stops the one of those that draws
    // anything (`session.focusInput`, read by the composer's ⌘L chip).
    expect(read(join(vendorSrc, "components/AppInitializer.tsx"))).toContain(
      "registerBuiltInCommands();",
    );
    for (const file of readdirSync(lodySrc).filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))) {
      expect(ourSource(file), `${file} registers no commands`).not.toContain(
        "registerBuiltInCommands",
      );
    }
  });

  it("still gates the composer chip on a registration", () => {
    // If upstream stops reading the registry for the chip, hunk 21 buys nothing
    // and C100 comes back. This is the line that would have changed.
    expect(read(join(vendorSrc, "components/chat/chat-composer.tsx"))).toContain(
      "commands.getKeybindingsFor('session.focusInput')",
    );
    expect(read(join(vendorSrc, "components/sessions/session-detail.tsx"))).toContain(
      "}, keyboardShortcutsAvailable);",
    );
  });
});

describe("the mobile branch IS mounted, and the routes stand down for it", () => {
  /* THIS DESCRIBE USED TO SAY THE OPPOSITE, and the inversion is the amendment
     rather than a weakening. Area 23 was KILL because both real routes dropped
     the mobile branch, so no v1 flag had to reach a phone. The user approved
     mounting it (`plans/LODY-V1-SCOPE.md` §5), and what this suite must now
     hold is the OTHER side of the same claim: exactly one thing draws the
     phone's landing and session, and every flag reaches it. */

  it("mounts the stack above both leaves, and both leaves return null on a phone", () => {
    const router = ourSource("router.tsx");
    // The stack outlives the chat -> session route change, so it hangs off the
    // route both leaves share. On a leaf it would be torn down by the very
    // navigation it exists to animate.
    expect(router).toContain("component: authRouteComponent(options.readOnly === true)");
    expect(router).toContain("<MobileSessionStack workspaceName={workspaceName}");
    // Two returns, one per leaf. A third would mean something else stood down.
    expect(router.match(/if \(isMobile\) return null;/gu)?.length).toBe(2);
    // The chat leaf still runs: its effect publishes the base context the stack
    // reads to keep the right page beneath an open session.
    expect(router).toContain("setMobileBaseContext({");
  });

  it("imports a vendored mobile screen from exactly one file", () => {
    // An IMPORT, not a mention: `router.tsx`'s doc comment cites
    // `components/mobile/mobile-workspace-stack.tsx` as the file whose route ids
    // ours reproduce, and that citation is why the ids match.
    //
    // ONE importer is the point. Two would mean two things draw the phone's
    // session, and the second would be a duplicate mount rather than a feature.
    const importers = readdirSync(lodySrc)
      .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
      .filter((f) => /^import .*components\/mobile\//mu.test(ourSource(f)));
    expect(importers).toEqual(["MobileSessionStack.tsx"]);
  });
});

describe("seam patch 7 is declared where a merge agent reads it", () => {
  const patches = read(join(repoRoot, "vendor/lody/BLITZ-PATCHES.md"));

  it("has a numbered entry naming every file it touches", () => {
    expect(patches).toContain("### 7. Host suppression of surfaces BlitzOS does not serve");
    for (const file of [
      "lib/session-github-state.ts",
      "components/sessions/session-chat-interface.tsx",
      "components/sessions/session-detail.tsx",
      "components/sessions/session-chat-input-area.tsx",
      "components/sessions/session-conversation-diff-panel.tsx",
      "components/chat/chat-landing.tsx",
      "components/chat/unified-project-selector.tsx",
    ]) {
      expect(patches, `seam patch 7 declares ${file}`).toContain(file);
    }
  });

  it("declares every prop the seam adds, on both sides", () => {
    // The vendored file must carry what the patch says it carries, and nothing
    // in our tree may pass a prop the vendor does not declare.
    const declarations: Record<string, string> = {
      "components/sessions/session-chat-interface.tsx": "hideCloudMenuItems?: boolean;",
      "components/sessions/session-chat-input-area.tsx": "hideAgentRoles?: boolean;",
      "components/chat/chat-landing.tsx": "hideProductHints?: boolean;",
    };
    for (const [file, declaration] of Object.entries(declarations)) {
      expect(read(join(vendorSrc, file)), `${file} declares ${declaration}`).toContain(declaration);
    }
    const detail = read(join(vendorSrc, "components/sessions/session-detail.tsx"));
    for (const prop of [
      "hideCloudMenuItems?: boolean;",
      "hideNotificationPrompt?: boolean;",
      "hideAgentRoles?: boolean;",
      "keyboardShortcutsAvailable?: boolean;",
      "hideLanguageServiceActions?: boolean;",
    ]) {
      expect(detail, `session-detail.tsx declares ${prop}`).toContain(prop);
    }
  });

  it("gates the GitHub surfaces on the capability upstream already has", () => {
    // Not a new flag: `PLATFORM_CAPABILITIES` names `githubIntegration`, and the
    // local platform's set is empty. If upstream drops the capability, these
    // gates become no-ops and the 22 rows come back.
    expect(read(join(repoRoot, "vendor/lody/packages/platform/src/capabilities.ts"))).toContain(
      "'githubIntegration',",
    );
    for (const file of [
      "components/sessions/session-chat-interface.tsx",
      "components/sessions/session-detail.tsx",
      "components/sessions/session-chat-input-area.tsx",
      "components/sessions/session-conversation-diff-panel.tsx",
      "components/chat/chat-landing.tsx",
      "components/chat/unified-project-selector.tsx",
    ]) {
      expect(read(join(vendorSrc, file)), `${file} asks for the capability`).toContain(
        "useAppCapability('githubIntegration')",
      );
    }
  });
});

describe("seam patches 13 and 14 are declared where a merge agent reads them", () => {
  const patches = read(join(repoRoot, "vendor/lody/BLITZ-PATCHES.md"));

  it("names the footer seam and the file it touches", () => {
    expect(patches).toContain("### 13. `LoroSidebar`'s footer, one entry at a time");
    expect(patches).toContain("components/loro-sidebar.tsx");
    // The prop the vendored file must carry, and the value our rail passes.
    expect(read(join(vendorSrc, "components/loro-sidebar.tsx"))).toContain(
      "footerItems?: readonly LoroSidebarFooterItem[];",
    );
    const rail = ourSource("SessionRailSidebar.tsx");
    expect(rail, "the rail keeps exactly the Archive entry").toContain(
      'const FOOTER_ITEMS = ["archive"] as const;',
    );
    expect(rail, "the rail no longer hides the whole footer").not.toContain("hideFooter");
  });

  it("names the archive seam and both files it touches", () => {
    expect(patches).toContain("### 14. The archive page's v1 scope cuts");
    for (const file of [
      "components/archive/archive-view.tsx",
      "components/archive/web-archive-screen.tsx",
    ]) {
      expect(patches, `seam patch 14 declares ${file}`).toContain(file);
      expect(read(join(vendorSrc, file)), `${file} declares hideTeamScope`).toContain(
        "hideTeamScope?: boolean;",
      );
    }
  });

  it("gates the archive row's PR badge on the capability upstream already has", () => {
    // Same mechanism as seam patch 7's GitHub half, and the same reason: the
    // capability exists, the local set is empty, and this row never asked.
    expect(read(join(vendorSrc, "components/archive/archive-view.tsx"))).toContain(
      "useAppCapability('githubIntegration')",
    );
  });
});

describe("seam patch 24 is declared where a merge agent reads it", () => {
  const patches = read(join(repoRoot, "vendor/lody/BLITZ-PATCHES.md"));

  it("names the seam and both files it touches", () => {
    expect(patches).toContain("### 24. A host bound to one machine may drop the composer's machine picker");
    for (const file of [
      "components/chat/chat-landing.tsx",
      "components/mobile/mobile-new-chat-sheet.tsx",
    ]) {
      expect(patches, `seam patch 24 declares ${file}`).toContain(file);
    }
  });

  it("declares the prop on the one component that draws both pickers", () => {
    expect(read(join(vendorSrc, "components/chat/chat-landing.tsx"))).toContain(
      "hideMachineSelector?: boolean;",
    );
  });

  it("leaves the writer alone, so selection still flows from agent and project", () => {
    // The picker is `handleMachineChange`'s only caller on the desktop. Hiding
    // it must not touch the two effects that CHOOSE a machine — that is the
    // difference between a hidden control and a broken send.
    const landing = read(join(vendorSrc, "components/chat/chat-landing.tsx"));
    expect(landing).toContain("setSelectedMachineId(selectedLocalProjectMachineId);");
    expect(landing).toContain("setSelectedMachineId(selectedAgent.machineId);");
  });

  it("drops the mobile row with its label rather than leaving it empty", () => {
    const sheet = read(join(vendorSrc, "components/mobile/mobile-new-chat-sheet.tsx"));
    expect(sheet).toContain("{machineNode ? (");
  });
});

describe("seam patch 15 is declared where a merge agent reads it", () => {
  const patches = read(join(repoRoot, "vendor/lody/BLITZ-PATCHES.md"));

  it("names the seam and every file it touches", () => {
    expect(patches).toContain("### 15. The host owns connectivity");
    for (const file of [
      "components/sessions/session-status-strip.tsx",
      "components/sessions/session-chat-interface.tsx",
      "components/sessions/session-detail.tsx",
      "components/sessions/session-file-content-view.tsx",
      "components/chat/chat-landing.tsx",
    ]) {
      expect(patches, `seam patch 15 declares ${file}`).toContain(file);
    }
  });

  it("declares the one prop on every level that carries it", () => {
    for (const file of [
      "components/sessions/session-chat-interface.tsx",
      "components/sessions/session-detail.tsx",
      "components/sessions/session-file-content-view.tsx",
      "components/chat/chat-landing.tsx",
    ]) {
      expect(read(join(vendorSrc, file)), `${file} declares hideConnectionStatus`).toContain(
        "hideConnectionStatus?: boolean;",
      );
    }
    // The resolver takes the flag by its own name, because it is the one place
    // that has to distinguish a connection state from `machine-removed`.
    expect(read(join(vendorSrc, "components/sessions/session-status-strip.tsx"))).toContain(
      "connectionStatusHidden?: boolean;",
    );
  });

  it("leaves the rail's ConnectionPill to seam patch 2's header suppression", () => {
    // The pill lives inside `LoroSidebar`'s workspace-identity header. If a
    // future rail stops hiding that header, the pill comes back and this seam
    // has no prop for it — which is what this assertion is here to catch.
    const rail = ourSource("SessionRailSidebar.tsx");
    expect(rail, "the rail still hides the header the pill renders in").toContain("hideHeader");
    expect(rail, "the rail gives the pill no state either").not.toContain("connectionUiState");
    expect(rail, "the rail gives the pill no state either").not.toContain("workspaceSyncing");
  });

  it("mounts no upstream layout, so the stuck-connection banner has no host", () => {
    // `StuckConnectionBannerContainer` mounts once, in `MainLayout`. We mount
    // pages, never upstream's roots — the same reason seam patch 15 declares no
    // hunk for it.
    //
    // A MOUNT, NOT A MENTION. The check was a bare substring until the mobile
    // stack imported `getMobileMainLayoutRootClassName` — two CLASS-NAME
    // helpers that `MainLayout` also calls, and that seam patch 16's mount
    // reproduces precisely BECAUSE it does not mount the layout that would
    // supply them. A mount is an import of the component or an element, so
    // that is what this looks for; the old spelling would have been satisfied
    // by deleting a doc comment.
    expect(read(join(vendorSrc, "components/main-layout.tsx"))).toContain(
      "StuckConnectionBannerContainer",
    );
    for (const file of readdirSync(lodySrc).filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))) {
      const source = ourSource(file);
      expect(source, `${file} renders no MainLayout`).not.toMatch(/<MainLayout[\s/>]/u);
      expect(source, `${file} imports no MainLayout`).not.toMatch(
        /^import \{[^}]*\bMainLayout\b/mu,
      );
      expect(source, `${file} imports no WorkspaceRuntimeShell`).not.toMatch(
        /^import \{[^}]*\bWorkspaceRuntimeShell\b/mu,
      );
    }
  });
});
