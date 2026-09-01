/**
 * Pins the reason `packages/webapp/vite.config.ts` aliases
 * `react-resizable-panels` to its browser build for tests.
 *
 * The package ships TWO implementations. Vitest resolves through the SSR
 * conditions (`node`/`edge-light`), and that build contains no
 * `useLayoutEffect` at all — every layout effect degrades to `useEffect`. So the
 * panel group has not computed a layout yet when a CONSUMER's layout effect
 * runs, and `panel.collapse()` throws `Panel size not found`. In the browser
 * build the group's layout effect runs first and the same call is fine.
 *
 * This matters because it is exactly what Lody's session page does:
 * `desktop-session-detail-layout.tsx:107` collapses its sidebar from a layout
 * effect on mount. Without the alias the whole session detail fails to render
 * under jsdom, for a reason that does not exist in a browser — which is how a
 * phase-3 exit-test run was lost.
 *
 * The test is the alias's guard: it fails if the alias is dropped, and it is a
 * plain component render, so it costs nothing.
 */
import { useLayoutEffect, useRef } from "react";
import { beforeAll, describe, expect, it } from "vitest";
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelHandle } from "react-resizable-panels";
import { installLodyDomStubs } from "./lody-dom-stubs";
import { render, settle } from "./dom";

beforeAll(() => installLodyDomStubs());

/** The shape `DesktopSessionDetailLayout` mounts: a collapsible sidebar panel
 * collapsed from the parent's layout effect on first commit. */
function CollapsingSidebarLayout() {
  const sidebar = useRef<ImperativePanelHandle>(null);
  useLayoutEffect(() => {
    sidebar.current?.collapse();
  }, []);
  return (
    <PanelGroup direction="horizontal" id="probe">
      <Panel id="main" order={1} defaultSize={70} minSize={20}>
        main
      </Panel>
      <PanelResizeHandle />
      <Panel
        id="sidebar"
        order={2}
        ref={sidebar}
        collapsible
        collapsedSize={0}
        defaultSize={30}
        minSize={10}
      >
        sidebar
      </Panel>
    </PanelGroup>
  );
}

describe("react-resizable-panels under jsdom", () => {
  it("collapses a panel from the parent's layout effect", async () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    try {
      const mounted = await render(<CollapsingSidebarLayout />);
      await settle();
      await mounted.unmount();
    } finally {
      console.error = original;
    }
    expect(errors.filter((line) => line.includes("Panel size not found"))).toEqual([]);
  });
});
