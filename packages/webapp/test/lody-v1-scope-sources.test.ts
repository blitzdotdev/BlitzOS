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
  it("still cuts all four groups", () => {
    // A flip is a product decision, not a refactor. It fails here first.
    expect(LODY_V1_SCOPE).toEqual({
      gitHubIntegration: false,
      agentRolesAndMcp: false,
      keyboardShortcuts: false,
      cloudSurfaces: false,
      languageService: false,
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
    });
  });
});

describe("router.tsx hands the suppression to both mounted components", () => {
  const router = ourSource("router.tsx");

  it("passes every prop `lodyV1SuppressionProps` returns", () => {
    // Read from the returned object rather than restated, so adding a fifth
    // suppression and forgetting to pass it fails here.
    for (const prop of Object.keys(lodyV1SuppressionProps())) {
      expect(router, `router.tsx passes ${prop}`).toContain(`${prop}={V1.${prop}}`);
    }
  });

  it("builds them from the scope constant and nothing else", () => {
    expect(router).toContain('from "./v1-scope.js"');
    expect(router).toContain("const V1 = lodyV1SuppressionProps();");
  });

  it("gives ChatLanding the hint and Role suppressions", () => {
    const start = router.indexOf("<ChatLanding");
    const landing = router.slice(start, router.indexOf("<SessionDetail"));
    expect(landing).toContain("hideProductHints={V1.hideProductHints}");
    expect(landing).toContain("hideAgentRoles={V1.hideAgentRoles}");
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

describe("the mobile branch is not mounted", () => {
  it("has no mobile route component and no vendored mobile import", () => {
    // C110, SP62, T28, X13, X14. Both real routes are the desktop ones; seam
    // patch 5 leaves `mobile-session-tab-sheet.tsx` unpatched on purpose.
    const router = ourSource("router.tsx");
    expect(router).toContain("Their `routes/$workspaceName/_auth/chat.tsx`, minus the mobile branch.");
    expect(router).toContain(
      "Their `routes/$workspaceName/_auth/sessions/$sessionId.tsx`, minus mobile.",
    );
    // An IMPORT, not a mention: `router.tsx`'s own doc comment cites
    // `components/mobile/mobile-workspace-stack.tsx` as the file whose route ids
    // ours reproduce, and that citation is the reason the ids match.
    for (const file of readdirSync(lodySrc).filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))) {
      expect(ourSource(file), `${file} mounts no vendored mobile screen`).not.toMatch(
        /^import .*components\/mobile\//mu,
      );
    }
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
