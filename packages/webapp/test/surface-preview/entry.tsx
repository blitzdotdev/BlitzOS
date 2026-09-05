/**
 * The Lody surface preview, composed the way the PRODUCT composes it.
 *
 * WHY THIS REPLACES `theme-review.tsx`. The previous preview page carried its
 * own stylesheet (`theme-review.css`) for the shell grid, the tab strip's rule
 * and the composer band, and it loaded four of the sixteen stylesheets
 * `main.tsx` loads. So it showed borders, spacing and section definition that
 * the product had never had, and the reskin was approved against a picture the
 * product could not produce. A preview that can style itself can lie; this one
 * cannot, because it declares no CSS of its own at all.
 *
 * THE TWO RULES THIS FILE OBEYS.
 *
 * 1. EVERY stylesheet is a product stylesheet, imported in `main.tsx`'s order,
 *    and no other. `packages/webapp/test/lody-preview-fidelity.test.ts` reads
 *    `main.tsx` and fails if the two lists drift apart.
 * 2. Every class name is one the product renders. The shell grid is
 *    `.app-shell.app-shell--workspace` (`app-shell.css`), the rail
 *    column is `.session-rail` inside `.shell-nav` (`ShellNav.tsx:80`), the
 *    surface's host is `.app-workspace-frame > .webapp-workspace-view`
 *    (`CloudApp.tsx:1612`), and the vendored zone is
 *    `.session-list.session-list--vendor` (`SessionRail.tsx:125`). Nothing here
 *    invents a box.
 *
 * What is a fixture, and stays one: the DATA. There is no daemon behind this
 * page, so the rows, the stream and the composer come from
 * `test/lody-fixtures.ts` — the same corpus the render harness uses.
 */
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";

// The product's stylesheets, in `main.tsx`'s order. Do not add one that is not
// there, and do not reorder: the cascade is part of what is being previewed.
import "@vscode/codicons/dist/codicon.css";
import "@xterm/xterm/css/xterm.css";
import "../../src/tokens.css";
import "../../src/webapp-icons.css";
import "../../src/webapp-base.css";
import "../../src/webapp-shell.css";
import "../../src/webapp-workspace.css";
import "../../src/browser/browser-panel.css";
import "../../src/webapp-select.css";
import "../../src/app-shell.css";
import "../../src/member-avatar.css";
import "../../src/strip-rail.css";
import "../../src/files.css";
import "../../src/confirmation-dialog.css";
import "../../src/error-dialog/error-dialog.css";
import "../../src/settings-surface.css";
import "../../src/workspace-details-dialog.css";
import "../../src/loading-skeleton.css";
import "../../src/create-workspace-dialog.css";
import "../../src/settings.css";
import "../../src/org-credentials.css";
import "../../src/invite-redeem.css";

import { BoxGlyph, ShareGlyph } from "../../src/shell/SessionRailIcons";
import { chooseTheme, resolvedTheme } from "../../src/theme";
import { SurfacePreviewRegion } from "./region";
import { WorkspaceSigilIcon } from "../../src/shell/WorkspaceStrip";

const WORKSPACE_TITLE = "zesty-swan";

/**
 * Column two's head, from `shell/SessionRail.tsx:80`.
 *
 * Native BlitzOS markup, styled by `strip-rail.css` alone — the part of the
 * rail the reskin must not touch, and the reference the vendored rows below it
 * have to line up with.
 */
function RailHead() {
  return (
    <div className="shell-rhead">
      <b title={WORKSPACE_TITLE}>{WORKSPACE_TITLE}</b>
      <span className="shell-rhead__sub" />
      <button className="shell-ib" type="button" aria-label={`Members of ${WORKSPACE_TITLE}`}>
        <ShareGlyph className="shell-ib__glyph" />
      </button>
      <button className="shell-ib" type="button" aria-label={`My machine in ${WORKSPACE_TITLE}`}>
        <BoxGlyph className="shell-ib__glyph" />
      </button>
      <button className="shell-ib" type="button" aria-label="Workspace details">
        <span className="codicon codicon-ellipsis" aria-hidden="true" />
      </button>
    </div>
  );
}

/** Column one, from `shell/WorkspaceStrip.tsx`. Only the tiles the rail needs to sit
 * beside something real; every class is `strip-rail.css`'s. Workspace tiles are
 * the first thing in the strip: the org mark that used to sit above them, and
 * the divider under it, are deleted (org switching is Settings → Profile). */
function Strip() {
  return (
    <aside className="shell-strip">
      <div className="shell-strip__tiles" role="tree">
        <button className="shell-wtile" type="button" role="treeitem" aria-selected="true">
          <span className="shell-wtile__indicator" aria-hidden="true" />
          <span className="shell-wtile__icon"><WorkspaceSigilIcon workspaceId="zesty-swan" /></span>
        </button>
        <button className="shell-wtile" type="button" role="treeitem" aria-selected="false">
          <span className="shell-wtile__indicator" aria-hidden="true" />
          <span className="shell-wtile__icon"><WorkspaceSigilIcon workspaceId="design-team" /></span>
        </button>
      </div>
      <span className="shell-strip__spacer" />
      <div className="shell-strip__account">
        <button className="shell-av" type="button">
          MS
        </button>
      </div>
    </aside>
  );
}

function PreviewShell() {
  const [mode, setMode] = useState(() => resolvedTheme());
  return (
    <main className="app-shell app-shell--workspace">
      <div className="shell-nav">
        <Strip />
        <aside className="session-rail" aria-label="Workspace sessions rail">
          <RailHead />
          <SurfacePreviewRegion />
        </aside>
      </div>
      <div className="app-workspace-frame">
        <section className="webapp-workspace-view" />
      </div>
      {/* The preview's OWN chrome, not the surface's. It carries inline
          styles because it is a control for looking at the subject rather than
          part of it — `lody-preview-fidelity.test.ts` asserts that
          `data-preview-chrome` is the only styled thing on the page that the
          product does not render. */}
      <div
        data-preview-chrome=""
        style={{ position: "fixed", right: 10, bottom: 10, display: "flex", gap: 6, zIndex: 99 }}
      >
        {(["dark", "light"] as const).map((choice) => (
          <button
            key={choice}
            type="button"
            className="shell-ib"
            aria-pressed={mode === choice}
            title={choice}
            style={{
              background: mode === choice ? "var(--selected)" : "var(--sunken)",
              color: "var(--ink)",
            }}
            onClick={() => {
              chooseTheme(choice);
              setMode(choice);
            }}
          >
            {choice === "dark" ? "D" : "L"}
          </button>
        ))}
      </div>
    </main>
  );
}

const host = document.getElementById("root");
if (host !== null) {
  createRoot(host).render(
    <StrictMode>
      <PreviewShell />
    </StrictMode>,
  );
}
