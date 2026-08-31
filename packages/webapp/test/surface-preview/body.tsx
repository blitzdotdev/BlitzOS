/**
 * The lazy chunk: every Lody stylesheet, and the vendored leaves themselves.
 *
 * The import list below is `SessionSurface.tsx`'s, in its order. That is the
 * whole point of this file existing separately from `entry.tsx` — see
 * `region.tsx` for why the boundary matters to the cascade.
 */
import { useState } from "react";
import { createPortal } from "react-dom";
import { LODY_SURFACE_CLASS } from "../../src/lody/surface-class";
import { BlitzThemedLodyTree, adoptShellTheme } from "../../src/lody/shell-theme";
import {
  FixtureComposer,
  FixtureSidebar,
  FixtureStream,
  LodyFixtureProviders,
} from "../lody-fixture-surface";
import "../../src/lody/lody-surface.css";
import "../../src/lody/lody-surface-shell.css";
import "../../src/lody/blitz-skin.css";

export interface SurfacePreviewBodyProps {
  /** The rail's vendored zone, `.session-list--vendor`. */
  railHost: HTMLElement;
  /** `section.webapp-workspace-view`, which the surface covers. */
  viewHost: HTMLElement;
}

/**
 * The chat pane, in the class `SessionSurface` gives it.
 *
 * `.lody-surface` is `position: absolute; inset: 0` over the workspace view
 * (`lody-surface-shell.css:46`), and its children take `flex: 1 1 auto`. The
 * stream and the composer are the vendored components; nothing here places
 * them beyond what the surface's own rule does.
 */
function SurfacePane() {
  return (
    <div className={LODY_SURFACE_CLASS}>
      <FixtureStream />
      <FixtureComposer />
    </div>
  );
}

export function SurfacePreviewBody(props: SurfacePreviewBodyProps) {
  const [theme] = useState(() => adoptShellTheme());
  return (
    <LodyFixtureProviders>
      <BlitzThemedLodyTree theme={theme}>
        {createPortal(<FixtureSidebar />, props.railHost)}
        {createPortal(<SurfacePane />, props.viewHost)}
      </BlitzThemedLodyTree>
    </LodyFixtureProviders>
  );
}

export default SurfacePreviewBody;
