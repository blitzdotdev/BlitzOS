/**
 * THE SIDE PANEL AND THE FILE VIEWER, AFTER THE panels-a SWEEP.
 *
 * Seven confirmed rows, five approved fixes and two user rulings. Each one is
 * pinned here at the lowest boundary that can hold it, and the boundary is not
 * the same for all of them:
 *
 * | Row | Pinned by | Why not lower |
 * |---|---|---|
 * | BUG-1 | the vendored source | `SessionDetail` needs a runtime, a Loro document and a daemon; the suites that mount it skip where the daemon is absent, which is CI. What is checkable without one is that the dialog is mounted in the DESKTOP return and not only in the mobile one — which is the whole defect. |
 * | BUG-2 | the real vendored `FileTreeProviderView`, driven | The panel that said "Files unavailable" and offered nothing renders from props alone, so it mounts here for real. The hook half (`reloadNonce`, the offline -> online re-arm) is pinned at the source: it needs jotai, presence and a workspace runtime. |
 * | BUG-3 | the real vendored strip + `blitz-skin.css` | jsdom runs no layout, so nothing here can show a box moving back inside the window. What IS checkable is that the rule's selector matches the strip the vendor renders, and that the element beside those controls still carries the `flex-1` that makes the declaration inert everywhere else. |
 * | SP28 | the vendored source | `SessionFileContentView` reads atoms, a runtime and the machine Flock. |
 * | SP23-I18N, SP21-KEY | the real i18next instance | Both are strings, so both are testable end to end — and each test ALSO asserts the vendored bundle still carries the defect, so an upstream fix deletes our override instead of hiding behind it. |
 * | SP26-LSP | `v1-scope.ts` + the vendored source | The gate is a flag, a prop chain and two `addAction` calls; mounting Monaco to watch an action not be registered would test Monaco. |
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FileTreeProviderView } from "@lody/components/components/sessions/components/file-tree-view";
import { SessionSidePanelTabBar } from "@lody/components/components/sessions/session-side-panel-tab-bar";
import { LODY_V1_SCOPE, lodyV1SuppressionProps } from "../src/lody/v1-scope.js";
import { BLITZ_LODY_EN_OVERRIDES, initLodyI18n } from "../src/lody/i18n.js";
import { installLodyDomStubs } from "./lody-dom-stubs.js";
import { render } from "./dom.js";

installLodyDomStubs();

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const vendorSrc = join(repoRoot, "vendor/lody/packages/components/src");
const read = (path: string): string => readFileSync(path, "utf8");
const vendor = (file: string): string => read(join(vendorSrc, file));

const sessionDetail = vendor("components/sessions/session-detail.tsx");
const fileContentView = vendor("components/sessions/session-file-content-view.tsx");
const fileProviderHook = vendor("hooks/use-code-collab-session-file-provider.ts");
const monacoController = vendor("lib/session-monaco-editor-controller.ts");
const monacoViewer = vendor("components/sessions/session-monaco-text-viewer.tsx");
const skinCss = read(join(repoRoot, "packages/webapp/src/lody/blitz-skin.css"));
const patches = read(join(repoRoot, "vendor/lody/BLITZ-PATCHES.md"));
const upstreamEn = JSON.parse(
  read(join(repoRoot, "vendor/lody/locales/en.json")),
) as Record<string, string>;

/** The part of `session-detail.tsx` the DESKTOP branch renders. The mobile
 * branch is an early `if (isMobile) { … }` return, and `<DesktopSessionDetailLayout`
 * appears once, in the return below it. */
const desktopBranch = sessionDetail.slice(sessionDetail.indexOf("<DesktopSessionDetailLayout"));

describe("BUG-1: quick open file is mounted on desktop, not only on mobile", () => {
  it("mounts the dialog in the desktop return", () => {
    // The chord always worked: the handler ran and reported
    // `defaultPrevented: true`. There was simply no dialog in the desktop tree
    // for it to open.
    expect(desktopBranch).toContain("{fileQuickOpenDialog}");
  });

  it("keeps the mobile mount, so the fix added a branch rather than moving one", () => {
    expect(sessionDetail.split("{fileQuickOpenDialog}")).toHaveLength(3);
  });

  it("still builds exactly one dialog for both branches to share", () => {
    expect(sessionDetail).toContain("const fileQuickOpenDialog = (");
    expect(sessionDetail).toContain("<SessionFileQuickOpen");
  });
});

describe("BUG-2: 'Files unavailable' is no longer terminal", () => {
  const unavailable = (onProviderRetry?: () => void) => (
    <FileTreeProviderView
      handleOpenFile={() => undefined}
      fileProvider={null}
      fileProviderPending={false}
      fileProviderMessage="Files are unavailable."
      {...(onProviderRetry === undefined ? {} : { onProviderRetry })}
    />
  );

  it("draws a working 'Try again' on the provider-unavailable panel", async () => {
    let retries = 0;
    const view = await render(unavailable(() => (retries += 1)));
    const button = [...view.container.querySelectorAll("button")].find((element) =>
      element.textContent?.includes("Try again"),
    );
    expect(button, "the unavailable panel offers a retry").toBeDefined();
    button?.click();
    expect(retries).toBe(1);
    await view.unmount();
  });

  it("draws none for a caller that has nothing to re-arm", async () => {
    // The prop is optional and the seam is inert without it: upstream's
    // Storybook and playground callers pass no retry and see what they saw.
    const view = await render(unavailable());
    expect(view.container.textContent).toContain("Files unavailable");
    expect(
      [...view.container.querySelectorAll("button")].some((element) =>
        element.textContent?.includes("Try again"),
      ),
    ).toBe(false);
    await view.unmount();
  });

  it("gives the provider an input a reconnect can move", () => {
    // The defect exactly: the acquisition effect's identity is `requestKey`,
    // and a reconnect changes none of `{cache, flockDocId, loadLocalSnapshot,
    // prepareTarget}`. `reloadNonce` is the input that can.
    expect(fileProviderHook).toContain(
      "() => ({ cache, flockDocId, loadLocalSnapshot, prepareTarget, reloadNonce }),",
    );
    expect(fileProviderHook).toContain(
      "[cache, flockDocId, loadLocalSnapshot, prepareTarget, reloadNonce]",
    );
  });

  it("re-arms on an offline -> online EDGE, never on a status", () => {
    // A "retry while the status is error" effect loops forever against a
    // machine that is online and answering errors. The edge fires at most once
    // per outage.
    expect(fileProviderHook).toContain("useMachineOnlineStatus(machineId)");
    expect(fileProviderHook).toContain("sawMachineOfflineRef.current = true;");
    expect(fileProviderHook).toContain(
      "if (machineOnlineStatus === 'online' && sawMachineOfflineRef.current) {",
    );
  });

  it("hands the session page's Files tab that same re-arm", () => {
    expect(sessionDetail).toContain("onProviderRetry={activeSessionCodeCollabFiles.reload}");
  });
});

describe("BUG-3: the collapsed strip's controls stay inside the window", () => {
  /** The skin's selector, and the DOM the panel really builds around it. */
  const COLLAPSED_STRIP_SELECTOR =
    '.lody-surface [data-lody-session-tab-region="side-panel"] > div:has([role="tablist"])';

  async function renderPanelCard() {
    return await render(
      <div className="lody-surface">
        <div data-lody-session-tab-region="side-panel">
          <SessionSidePanelTabBar
            tabs={[{ id: "files", label: "Files", kind: "files" as const }]}
            activeTabId="files"
            availablePanels={[{ id: "changes", label: "All Changes", kind: "changes" as const }]}
            onTabSelect={() => undefined}
            onTabClose={() => undefined}
            addPanelLabel="Add panel"
            closeTabLabel={(label: string) => `Close ${label}`}
            endSlot={<button type="button" aria-label="Show sidebar" />}
          />
        </div>
      </div>,
    );
  }

  it("carries the rule, scoped to the side panel", () => {
    const rule = new RegExp(
      String.raw`\.lody-surface \[data-lody-session-tab-region="side-panel"\] > div:has\(\[role="tablist"\]\) \{([^}]*)\}`,
      "u",
    ).exec(skinCss)?.[1];
    expect(rule, "the skin carries the collapsed-strip rule").toBeDefined();
    // Overflow leaves a flex row by the edge alignment did NOT pack against, so
    // `flex-end` sends it left, back into the window.
    expect(rule).toContain("justify-content: flex-end");
  });

  it("selects the strip the vendored panel actually renders", async () => {
    const view = await renderPanelCard();
    const matched = [...view.container.ownerDocument.querySelectorAll(COLLAPSED_STRIP_SELECTOR)];
    expect(matched, "exactly one element takes the rule").toHaveLength(1);
    // And it is the row that holds the two controls that overflowed.
    expect(matched[0]?.querySelector('[aria-label="Add panel"]')).not.toBeNull();
    expect(matched[0]?.querySelector('[aria-label="Show sidebar"]')).not.toBeNull();
    await view.unmount();
  });

  it("cannot move anything while the strip has room", async () => {
    // `justify-content` distributes FREE space, and the scroll area beside
    // those controls is `flex-1`: it absorbs every pixel, so there is never any
    // to distribute. The declaration is observable in exactly one state — a
    // container narrower than its own controls, which is the collapsed panel.
    const view = await renderPanelCard();
    const strip = view.container.ownerDocument.querySelector(COLLAPSED_STRIP_SELECTOR);
    const flexible = strip?.querySelector('[role="tablist"]')?.closest(".flex-1");
    expect(flexible, "the tablist still sits in a flex-1 sibling").not.toBeNull();
    expect(flexible?.className).toContain("min-w-0");
    await view.unmount();
  });
});

describe("SP28: the desktop file viewer can copy the path it is showing", () => {
  it("draws the control upstream's mobile drawer already models", () => {
    // `MobileFileViewerDrawer` has carried this action under the same key since
    // it landed; the desktop toolbar had no copy-path entry at all.
    expect(vendor("components/mobile/mobile-file-viewer-drawer.tsx")).toContain(
      "t('sessions.fileViewer.copyPath', 'Copy file path')",
    );
    expect(fileContentView).toContain(
      "aria-label={t('sessions.fileViewer.copyPath', 'Copy file path')}",
    );
    expect(fileContentView).toContain("onClick={() => void handleCopyFilePath()}");
  });

  it("copies the viewer's own normalized path, and says whether it worked", () => {
    expect(fileContentView).toContain("await writeTextToClipboard(normalizedPath)");
    expect(fileContentView).toContain(
      "tRef.current('sessions.fileViewer.pathCopied', 'File path copied')",
    );
  });

  it("keeps the toolbar rendered for a file whose only action is this one", () => {
    // A binary preview has no search, save or refresh button, so before this
    // the top bar did not render at all — and the path is knowable for every
    // file the viewer can show.
    expect(fileContentView).toContain("const showCopyPathButton = normalizedPath.length > 0;");
    expect(fileContentView).toMatch(/showRefreshButton \|\|\n {4}showCopyPathButton;/u);
  });

  it("uses a key the vendored bundle already ships", () => {
    expect(upstreamEn["sessions.fileViewer.copyPath"]).toBe("Copy file path");
  });
});

describe("SP23-I18N: the save-conflict banner interpolates nothing", () => {
  const i18n = initLodyI18n();

  it("is a defect in the vendored bundle, and this override is why", () => {
    // The reason to assert this: when upstream fixes the string, this test
    // fails and the override is deleted rather than left shadowing a good one.
    expect(upstreamEn["sessions.fileSave.conflictDetail"]).toContain("{{conflict}}");
  });

  it("has no call site that could supply one", () => {
    // `SessionFileConflictActionRow` reads the key with no options, and there
    // is no conflict object in scope to name. The placeholder is unfillable,
    // not unfilled.
    expect(fileContentView).toContain("'sessions.fileSave.conflictDetail',");
    expect(fileContentView).toContain(
      "'The file changed on disk while you were editing. Choose how to reconcile.'",
    );
  });

  it("renders a whole sentence to the member", () => {
    const rendered = i18n.t("sessions.fileSave.conflictDetail");
    expect(rendered).not.toContain("{{");
    expect(rendered).toBe(BLITZ_LODY_EN_OVERRIDES["sessions.fileSave.conflictDetail"]);
  });
});

describe("SP21-KEY: the Save button stops advertising a dead chord", () => {
  const i18n = initLodyI18n();

  it("is the string the vendored bundle ships", () => {
    expect(upstreamEn["sessions.fileViewer.save.withShortcut"]).toContain("Ctrl+S");
  });

  it("promises nothing a BlitzOS box does not answer", () => {
    // The chord is dead BY DESIGN: `v1-scope.ts` mounts no command dispatcher
    // and no palette, so `$mod+s` has no owner. The button keeps the action and
    // drops the promise.
    expect(LODY_V1_SCOPE.keyboardShortcuts).toBe(false);
    expect(i18n.t("sessions.fileViewer.save.withShortcut")).toBe("Save");
  });

  it("leaves the conflict title alone, which is the other thing that title says", () => {
    expect(i18n.t("sessions.fileViewer.save.conflict")).toBe("Resolve the save conflict first");
  });
});

describe("SP26-LSP: Go to Definition and Find References are off for v1", () => {
  it("is one field, off, like the other four scope cuts", () => {
    expect(LODY_V1_SCOPE.languageService).toBe(false);
    expect(lodyV1SuppressionProps().hideLanguageServiceActions).toBe(true);
  });

  it("reaches the file viewer through the page that mounts it", () => {
    expect(read(join(repoRoot, "packages/webapp/src/lody/router.tsx"))).toContain(
      "hideLanguageServiceActions={V1.hideLanguageServiceActions}",
    );
    expect(sessionDetail).toContain("hideLanguageServiceActions?: boolean;");
    expect(sessionDetail).toContain("lspAvailable={!hideLanguageServiceActions}");
  });

  it("takes the ACTIONS off the editor, not just their callbacks", () => {
    // An action whose callback is `undefined` still sits in the context menu
    // and does nothing at all, which is worse than the message it replaces.
    expect(fileContentView).toContain("lspActions={lspAvailable}");
    expect(monacoViewer).toContain("lspActions,");
    expect(monacoController).toContain("if (options.lspActions !== false) {");
    expect(monacoController).toContain("id: 'lody.codeCollab.goToDefinition',");
    expect(monacoController).toContain("id: 'lody.codeCollab.findReferences',");
  });

  it("stops the RPC that answered 'unsupported' as well", () => {
    expect(fileContentView).toMatch(/const isLspEnabled =\n {4}lspAvailable &&/u);
  });

  it("defaults to today's behaviour at every level, so the seam is inert", () => {
    expect(fileContentView).toContain("lspAvailable = true,");
    expect(monacoViewer).toContain("lspActions = true,");
    expect(sessionDetail).toContain("hideLanguageServiceActions = false,");
  });
});

describe("seam patch 9 is declared where a merge agent reads it", () => {
  it("has a numbered entry naming every vendored file it touches", () => {
    expect(patches).toContain("### 9. The side panel's file surfaces");
    for (const file of [
      "components/sessions/session-detail.tsx",
      "hooks/use-code-collab-session-file-provider.ts",
      "components/sessions/components/file-tree-view.tsx",
      "components/sessions/session-file-content-view.tsx",
      "components/sessions/session-monaco-text-viewer.tsx",
      "lib/session-monaco-editor-controller.ts",
    ]) {
      expect(patches, `seam patch 9 declares ${file}`).toContain(file);
    }
  });

  it("moves the file count the merge drill checks against", () => {
    // Seam patch 1's verification step names the expected number of diverged
    // files. Five new ones is a number, and a stale one hides the next patch.
    expect(patches).toContain("NINETEEN files");
  });

  it("records that BUG-3 needed no vendored hunk", () => {
    expect(patches).toContain("**BUG-3, the collapsed strip's off-screen controls, needed no hunk.**");
  });
});
