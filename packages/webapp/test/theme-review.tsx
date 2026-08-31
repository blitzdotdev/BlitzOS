/**
 * The theme review page: the reskinned Lody surface, from fixtures, inside the
 * rail chrome it really lives in.
 *
 * WHY IT EXISTS. Every other check in this suite reads VALUES — the compiled
 * theme record, the selectors a rule matches. None of them can answer "does it
 * look like BlitzOS", and that is the question the reskin was asked. So this
 * composes the same vendored leaves the render harness uses (`LoroSidebar`,
 * `SessionChatStreamView`, `ChatComposer`) with the NATIVE rail chrome around
 * them — `div.shell-rhead` above, the `.shell-s` Terminals rows inside the
 * sidebar's own `afterSessionListContent` slot — because the convergence being
 * reviewed is precisely whether the two kinds of row in that one column read as
 * one component.
 *
 * IT MIRRORS THE PRODUCT MOUNT, NOT A CONVENIENT ONE. `FixtureSidebar` passes
 * the same props `SessionRailSidebar` passes — `hideHeader`, `hideFooter`, the
 * pinned width, the `home` relabel, the GitHub Worktrees `topContent`, and
 * Chats plus Terminals in `afterSessionListContent`. A review page that mounts
 * the sidebar its own way reviews a component the product does not render.
 *
 * TWO WAYS TO SEE IT.
 *
 * - `npm run dev -w @blitzos/webapp`, then `/theme-review.html`. That is the
 *   live render: real Tailwind, real cascade, real `color-mix()`.
 * - The last block of `packages/webapp/test/lody-fixture-render.test.tsx` emits
 *   a single self-contained HTML file with the same markup and every stylesheet
 *   inlined, for review somewhere without a dev server:
 *
 *     BLITZ_THEME_REVIEW_OUT=/tmp/preview.html \
 *       npx vitest run test/lody-fixture-render.test.tsx
 *
 * It lives under `test/` rather than `src/` deliberately: it imports the render
 * fixtures, and nothing here ships in the product bundle. `theme-review.html`
 * is not a Rollup input, so `vite build` never sees it.
 */
import { useState, type ReactNode } from "react";
import { TabPillStrip } from "@lody/components/components/shared/tab-pill-strip";
import {
  FixtureComposer,
  FixtureSidebar,
  FixtureStream,
  LodyFixtureProviders,
} from "./lody-fixture-surface";
import { BoxGlyph, ShareGlyph } from "../src/files/DriveIcons";
import { LODY_SURFACE_CLASS } from "../src/lody/surface-class";

const WORKSPACE_TITLE = "BlitzOS";

/**
 * Column two's head, reproduced from `shell/SessionRail.tsx:80`.
 *
 * Byte-for-byte, and that matters: the head is the part of the rail the reskin
 * must NOT touch. It is native BlitzOS markup styled only by `strip-rail.css`,
 * so a rule of the theme or the skin that reached outside the vendored zone
 * would show here first. (`lody-blitz-theme.test.ts` proves the same claim by
 * selector, which is its exact form; this is the version an eye can check.)
 *
 * There is deliberately NO `.shell-newbar` under it: with the vendored sidebar
 * mounted, "New session" is `LoroSidebar`'s own `home` entry with our word on
 * it (`SessionRailSidebar.tsx:448`), and `SessionRail` draws the native bar only
 * on its `!vendored` branch.
 */
function NativeRailHead() {
  return (
    <div className="shell-rhead">
      <b title={WORKSPACE_TITLE}>{WORKSPACE_TITLE}</b>
      {/* The mockup's RAM readout: holds its place, empty until Build 2. */}
      <span className="shell-rhead__sub" />
      <button
        className="shell-ib"
        type="button"
        aria-label={`Members of ${WORKSPACE_TITLE}`}
        title={`Members of ${WORKSPACE_TITLE}`}
      >
        <ShareGlyph className="shell-ib__glyph" />
      </button>
      <button
        className="shell-ib"
        type="button"
        aria-label={`My machine in ${WORKSPACE_TITLE}`}
        title={`My machine in ${WORKSPACE_TITLE}`}
      >
        <BoxGlyph className="shell-ib__glyph" />
      </button>
      <button
        className="shell-ib"
        type="button"
        aria-label={`Workspace details for ${WORKSPACE_TITLE}`}
        title={`Workspace details for ${WORKSPACE_TITLE}`}
      >
        <span className="codicon codicon-ellipsis" aria-hidden="true" />
      </button>
    </div>
  );
}

const TAB_ITEMS = [
  { key: "rail-swap", label: "rail swap" },
  { key: "login-redirect", label: "fix the login redirect" },
  { key: "theme", label: "blitz theme" },
];

/**
 * The whole review surface.
 *
 * `.lody-surface` wraps the pane exactly as `SessionSurface` does, and the rail's
 * list region carries `session-list--vendor` exactly as `strip-rail.css` names
 * it — those two classes are what the generated theme sheet and `blitz-skin.css`
 * scope to, so a mistake in either shows up here rather than only in production.
 */
export function ThemeReviewPage(props: { children?: ReactNode }) {
  const [tab, setTab] = useState("rail-swap");
  return (
    <LodyFixtureProviders>
      <div className="review-shell">
        <aside className="shell-strip">
          <span className="shell-orgmark">BZ</span>
          <span className="shell-strip__sep" />
          <button className="shell-wtile shell-wtile--on" type="button">
            BO
          </button>
          <button className="shell-wtile" type="button">
            DT
          </button>
          <span className="shell-strip__spacer" />
          <span className="shell-av">MS</span>
        </aside>

        <aside className="session-rail" aria-label="Workspace sessions rail">
          <NativeRailHead />
          <div
            className="session-list session-list--vendor"
            role="group"
            aria-label={`Sessions in ${WORKSPACE_TITLE}`}
          >
            <FixtureSidebar />
          </div>
        </aside>

        <section className="review-main">
          <div className={`${LODY_SURFACE_CLASS} review-surface`}>
            <div className="review-tabs">
              <TabPillStrip
                items={TAB_ITEMS}
                activeKey={tab}
                onSelect={setTab}
                ariaLabel="Sessions"
              />
            </div>
            <div className="review-stream">
              <FixtureStream />
            </div>
            <div className="review-composer">
              <FixtureComposer />
            </div>
          </div>
        </section>
        {props.children}
      </div>
    </LodyFixtureProviders>
  );
}

export default ThemeReviewPage;
